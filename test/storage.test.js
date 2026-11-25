import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startReviewRelay } from '../api/runtime.js';

const watchId = '59e08952-6ba4-4625-9ea3-1708fafb9655';
const pendingId = `${watchId}:d8d3815e-cfba-4637-ab56-aa12d23468ab`;
const queuedId = `${watchId}:29ef3382-ab4c-491a-ba49-019537e66c83`;

function seedOldInbox(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE links (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, login TEXT NOT NULL,
        role TEXT NOT NULL, thread TEXT NOT NULL, title TEXT, worktree TEXT,
        status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, ended INTEGER
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY, link TEXT NOT NULL REFERENCES links(id), kind TEXT NOT NULL,
        ref INTEGER, head TEXT, received INTEGER NOT NULL, ready INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('imported', '1'), ('delivery-mode', 'push');
    `);
    db.prepare(`INSERT INTO links (id, repo, number, login, role, thread, title, created)
      VALUES (?, 'example/example', 12, 'example', 'author', ?, 'Existing PR', 1)`).run(
      watchId,
      watchId,
    );
    db.prepare(`INSERT INTO events (id, link, kind, ref, received, ready, status, attempts)
      VALUES (?, ?, 'changes', 21, 2, 2, 'pending', 0), (?, ?, 'review', 20, 1, 1, 'queued', 1)`).run(
      pendingId,
      watchId,
      queuedId,
      watchId,
    );
  } finally {
    db.close();
  }
}

test('an existing inbox keeps its history and resumes pending feedback across the Cricket migration', {
  timeout: 15_000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'review-relay-storage-'));
  const codex = join(temp, 'codex');
  const deliveries = join(temp, 'deliveries');
  let app;
  t.after(async () => {
    try {
      await app?.stop('test completed');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  seedOldInbox(join(temp, 'inbox.sqlite'));
  await writeFile(
    codex,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(deliveries)}, JSON.stringify(process.argv.at(-1)) + '\\n');
`,
    { mode: 0o700 },
  );

  const env = {
    PR_CHAT_PORT: '0',
    PR_CHAT_STATE_DIR: temp,
    PR_CHAT_LEGACY: join(temp, 'no-legacy'),
    PR_CHAT_GH: join(temp, 'no-gh'),
    PR_CHAT_CODEX: codex,
    PR_CHAT_OPEN: '/usr/bin/true',
    PR_CHAT_NOTIFIER: join(temp, 'no-notifier'),
  };
  app = await startReviewRelay(env);
  const response = await fetch(`${app.origin}/stream`, { signal: t.signal });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let snapshot;
  try {
    while (!snapshot) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const view = JSON.parse(frame.slice(6));
        if (view.events.some((event) => event.id === pendingId && event.status === 'queued')) {
          snapshot = view;
        }
      }
    }
    assert.equal(snapshot.links.find((link) => link.id === watchId).provider, 'codex');
    assert.equal(snapshot.events.find((event) => event.id === queuedId).sentAt, null);
    assert.ok(snapshot.events.find((event) => event.id === pendingId).sentAt > 0);
    await app.stop('test restart');
    // Leave the subscriber connected so shutdown exercises Cricket's stream cancellation.
    for (;;) {
      if ((await reader.read()).done) break;
    }
  } finally {
    await reader.cancel();
  }

  app = await startReviewRelay(env);
  const restarted = await fetch(`${app.origin}/api/state`, { signal: t.signal });
  const view = await restarted.json();
  assert.deepEqual(view.events, snapshot.events);
  const sent = (await readFile(deliveries, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /pullrequestreview-21/);
});
