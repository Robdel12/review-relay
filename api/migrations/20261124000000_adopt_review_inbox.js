export async function up(db) {
  await db.raw(`CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, login TEXT NOT NULL,
    role TEXT NOT NULL, thread TEXT NOT NULL, title TEXT, worktree TEXT,
    status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, ended INTEGER,
    provider TEXT NOT NULL DEFAULT 'codex'
  )`);
  await db.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS open_pr ON links (repo, number) WHERE status = 'open'`,
  );
  await db.raw(`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, link TEXT NOT NULL REFERENCES links(id), kind TEXT NOT NULL,
    ref INTEGER, head TEXT, received INTEGER NOT NULL, ready INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER
  )`);
  await db.raw(`CREATE INDEX IF NOT EXISTS ready_events ON events (status, ready)`);
  await db.raw(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  if (!(await db.schema.hasColumn('links', 'provider'))) {
    await db.schema.alterTable('links', (links) =>
      links.text('provider').notNullable().defaultTo('codex'),
    );
  }
  if (!(await db.schema.hasColumn('events', 'sent_at'))) {
    await db.schema.alterTable('events', (events) => events.integer('sent_at'));
  }
}

export function down() {
  throw new Error('This migration adopts an existing inbox and cannot be rolled back.');
}
