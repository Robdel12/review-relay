import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { on, once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { startReviewRelay } from '../api/runtime.js';

test('the push relay can cut over, deliver a review once, and archive its watch', {
  timeout: 15_000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'review-relay-push-'));
  const gh = join(temp, 'gh');
  const codex = join(temp, 'codex');
  const deliveries = join(temp, 'deliveries');
  let app;
  let bridge;
  t.after(async () => {
    try {
      await app?.stop('test completed');
      if (bridge) {
        for (const client of bridge.clients) client.terminate();
        await new Promise((resolve, reject) =>
          bridge.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  await writeFile(
    gh,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'pr') console.log('{"title":"Example PR","author":{"login":"example"},"state":"OPEN"}');
else if (args.includes('--jq')) console.log('example');
else if (args.includes('user')) console.log('{"login":"example"}');
else if (args.includes('--paginate')) console.log('[[]]');
else console.log('{"state":"open"}');
`,
    { mode: 0o700 },
  );
  await writeFile(
    codex,
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(deliveries)}, JSON.stringify(process.argv.at(-1)) + '\\n');
`,
    { mode: 0o700 },
  );

  bridge = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(bridge, 'listening', { signal: t.signal });
  const connection = once(bridge, 'connection', { signal: t.signal }).then(([socket]) => ({
    socket,
    messages: on(socket, 'message', { signal: t.signal }),
  }));
  app = await startReviewRelay({
    PR_CHAT_PORT: '0',
    PR_CHAT_STATE_DIR: join(temp, 'state'),
    PR_CHAT_LEGACY: join(temp, 'no-legacy'),
    PR_CHAT_GH: gh,
    PR_CHAT_CODEX: codex,
    PR_CHAT_NOTIFIER: join(temp, 'no-notifier'),
    PR_CHAT_ALLOW_HTTP: '1',
    PR_CHAT_BATCH_MS: '0',
  });

  const post = (path, data) =>
    fetch(app.origin + path, {
      method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: t.signal,
    });
  const linked = await post('/api/links', {
    pr: 'https://github.com/example/example/pull/1',
    chat: randomUUID(),
  });
  assert.equal(linked.status, 200);
  const watch = await linked.json();

  const stream = await fetch(`${app.origin}/stream`, { signal: t.signal });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  async function waitFor(predicate) {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const view = JSON.parse(buffer.slice(6, end));
        buffer = buffer.slice(end + 2);
        if (predicate(view)) return view;
        continue;
      }
      const { done, value } = await reader.read();
      assert.equal(done, false);
      buffer += value;
    }
  }

  try {
    const [paired, { socket, messages }] = await Promise.all([
      post('/api/pair', {
        url: `http://127.0.0.1:${bridge.address().port}`,
        token: 'a'.repeat(64),
      }),
      connection,
    ]);
    assert.equal(paired.status, 200, await paired.text());

    async function nextMessage(type) {
      for (;;) {
        const { value, done } = await messages.next();
        assert.equal(done, false);
        const message = JSON.parse(value[0].toString());
        if (message.type === type) return message;
      }
    }

    const sync = await nextMessage('sync');
    assert.deepEqual(
      sync.links.map(({ id }) => id),
      [watch.id],
    );
    socket.send(JSON.stringify({ type: 'synced', links: [watch.id], repo: 'example/example' }));
    socket.send(JSON.stringify({ type: 'events', events: [], lastWebhook: Date.now() }));
    await waitFor(
      (view) =>
        view.relay.status === 'connected' && view.relay.lastWebhook && view.delivery.lastPoll,
    );
    const cutover = await post('/api/cutover', {});
    assert.equal(cutover.status, 200, await cutover.text());

    async function send(event) {
      socket.send(JSON.stringify({ type: 'events', events: [event], lastWebhook: Date.now() }));
      assert.deepEqual((await nextMessage('ack')).ids, [event.id]);
    }

    const review = {
      id: `${watch.id}:${randomUUID()}`,
      link: watch.id,
      kind: 'changes',
      ref: 42,
      received: Date.now(),
    };
    await send(review);
    await waitFor((view) =>
      view.events.some((event) => event.id === review.id && event.status === 'queued'),
    );
    await send(review);

    await send({ ...review, id: `${watch.id}:${randomUUID()}`, kind: 'merged' });
    const history = await waitFor((view) =>
      view.links.some((link) => link.id === watch.id && link.status === 'merged'),
    );
    assert.equal(history.delivery.mode, 'push');
    assert.equal(history.events.filter((event) => event.id === review.id).length, 1);
    assert.equal(history.events.find((event) => event.kind === 'merged').status, 'archived');
    const sent = (await readFile(deliveries, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /pullrequestreview-42/);
    await messages.return();
  } finally {
    await reader.cancel();
  }
});
