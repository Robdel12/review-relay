import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeLink, uuid } from '../../../protocol.js';

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, login TEXT NOT NULL,
    role TEXT NOT NULL, thread TEXT NOT NULL, title TEXT, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, ended INTEGER,
    provider TEXT NOT NULL DEFAULT 'codex'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS open_pr ON links (repo, number) WHERE status = 'open';
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, link TEXT NOT NULL REFERENCES links(id), kind TEXT NOT NULL,
    ref INTEGER, head TEXT, received INTEGER NOT NULL, ready INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS ready_events ON events (status, ready);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function queries(db) {
  const prepare = (method) => (sql) => {
    const statement = db.prepare(sql);
    return statement[method].bind(statement);
  };
  const get = prepare('get');
  const all = prepare('all');
  const run = prepare('run');
  const setting = get('SELECT value FROM settings WHERE key = ?');
  const insertWatch = run(`INSERT OR IGNORE INTO links
    (id, repo, number, login, role, thread, title, worktree, status, created, ended, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDelivery = run(`INSERT OR IGNORE INTO events
    (id, link, kind, ref, head, received, ready, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const saveDelivery = run(
    'UPDATE events SET status = ?, attempts = ?, ready = ?, sent_at = ? WHERE id = ?',
  );
  const nextCodexDeadline =
    get(`SELECT MIN(events.ready) AS ready FROM events JOIN links ON events.link = links.id
    WHERE events.status = 'pending' AND links.provider = 'codex'`);
  const nextCodexLink = get(`SELECT events.link FROM events JOIN links ON events.link = links.id
    WHERE events.status = 'pending' AND events.ready <= ? AND links.provider = 'codex'
    ORDER BY events.ready LIMIT 1`);

  return Object.freeze({
    setting: (key) => setting(key)?.value,
    set: run('INSERT OR REPLACE INTO settings VALUES (?, ?)'),
    addWatch: ({
      id,
      repo,
      number,
      login,
      role,
      thread,
      title,
      worktree,
      status,
      created,
      ended,
      provider,
    }) =>
      insertWatch(
        id,
        repo,
        number,
        login,
        role,
        thread,
        title,
        worktree,
        status,
        created,
        ended,
        provider,
      ),
    watch: get('SELECT * FROM links WHERE id = ?'),
    openWatch: get("SELECT * FROM links WHERE repo = ? AND number = ? AND status = 'open'"),
    openWatches: all("SELECT * FROM links WHERE status = 'open' ORDER BY created DESC"),
    matchingWatch: get(`SELECT * FROM links
      WHERE repo = ? AND number = ? AND thread = ? AND provider = ? AND status = ? LIMIT 1`),
    updateWatch: run('UPDATE links SET title = ?, worktree = ? WHERE id = ?'),
    endWatch: run('UPDATE links SET status = ?, ended = ? WHERE id = ?'),
    dashboardWatches: all(
      "SELECT * FROM links ORDER BY (status = 'open') DESC, created DESC LIMIT 100",
    ),
    dashboardDeliveries:
      all(`SELECT events.id, events.kind, events.status, events.received, events.sent_at AS sentAt,
      links.repo, links.number, links.thread, links.role, links.provider, links.status AS watchStatus
      FROM events JOIN links ON links.id = events.link ORDER BY events.received DESC LIMIT 35`),
    addDelivery: ({ id, link, kind, ref, head, received, ready, status }) =>
      insertDelivery(id, link, kind, ref, head, received, ready, status).changes !== 0,
    pendingDelivery: get("SELECT 1 FROM events WHERE link = ? AND status = 'pending' LIMIT 1"),
    postponeNewDeliveries: run(`UPDATE events SET ready = ? WHERE link = ?
      AND status = 'pending' AND attempts = 0`),
    delivery: get('SELECT * FROM events WHERE id = ?'),
    setDelivery: (id, { status, attempts, ready, sentAt }) =>
      saveDelivery(status, attempts, ready, sentAt, id),
    cancelableDeliveries: all(
      "SELECT * FROM events WHERE link = ? AND status IN ('pending', 'failed')",
    ),
    claudeDeliveries: all(`SELECT events.* FROM events JOIN links ON events.link = links.id
      WHERE links.provider = 'claude' AND links.thread = ? AND links.status = 'open' AND events.status = 'pending'
      ORDER BY events.received LIMIT 25`),
    nextCodexDeadline: () => nextCodexDeadline().ready,
    nextCodexLink: (now) => nextCodexLink(now)?.link,
    readyDeliveries: all(`SELECT * FROM events
      WHERE link = ? AND status = 'pending' AND ready <= ? ORDER BY received LIMIT 25`),
  });
}

export async function openReviewStore(path, legacy) {
  const db = new DatabaseSync(path);
  let tail = Promise.resolve();
  function serialize(action) {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  }

  try {
    db.exec(schema);
    if (
      !db
        .prepare('PRAGMA table_info(links)')
        .all()
        .some((column) => column.name === 'provider')
    ) {
      db.exec("ALTER TABLE links ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex'");
    }
    if (
      !db
        .prepare('PRAGMA table_info(events)')
        .all()
        .some((column) => column.name === 'sent_at')
    ) {
      db.exec('ALTER TABLE events ADD COLUMN sent_at INTEGER');
    }
    const rows = queries(db);

    // Cricket validates transitions asynchronously. Queue SQLite access so requests cannot see
    // partial writes while a transition is being evaluated. Callbacks here do no external I/O.
    const store = Object.freeze({
      read: (action) => serialize(() => action(rows)),
      write: (action) =>
        serialize(async () => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const result = await action(rows);
            db.exec('COMMIT');
            return result;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }),
      close: () => serialize(() => db.close()),
    });

    await store.write((rows) => {
      if (rows.setting('imported')) return;
      for (const entry of Object.values(legacy)) {
        const watch = normalizeLink({ ...entry, id: randomUUID() });
        if (!watch || !uuid.test(entry.thread)) continue;
        rows.addWatch({
          ...watch,
          thread: entry.thread,
          title: null,
          worktree: entry.worktree ?? null,
          status: entry.status === 'open' ? 'open' : 'closed',
          created: Date.now(),
          ended: null,
          provider: 'codex',
        });
      }
      rows.set('imported', '1');
    });
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}
