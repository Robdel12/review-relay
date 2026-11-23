import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

test('polls new author and reviewer links, remembers deliveries, and archives merged PRs', { timeout: 25_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pr-chat-poll-'));
  const fixture = join(temp, 'github.json');
  const deliveries = join(temp, 'deliveries.jsonl');
  const gh = join(temp, 'gh');
  const codex = join(temp, 'codex');
  const socket = createServer();
  await once(socket.listen(0, '127.0.0.1'), 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const repo = 'example/example';
  const authorChat = randomUUID();
  const reviewerChat = randomUUID();
  const legacy = join(temp, 'legacy.json');
  const authorURL = `https://github.com/${repo}/pull/1`;
  await writeFile(legacy, JSON.stringify({ [repo + '#1']: {
    repo, number: 1, login: 'rob', role: 'author', thread: authorChat, status: 'open',
    seen: ['review/7'],
  } }));
  const pull = (number, requested_reviewers = []) => ({ number, state: 'open', head: { sha: 'a'.repeat(40) }, requested_reviewers });
  const github = { pulls: { 1: pull(1), 2: pull(2) }, timeline: { 1: [], 2: [] }, comments: { 1: [] } };
  async function publish() {
    const swap = fixture + '.tmp';
    await writeFile(swap, JSON.stringify(github));
    await rename(swap, fixture);
  }
  await publish();

  await writeFile(gh, `#!${process.execPath}
const f = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'pr') {
  const number = Number(args[2].split('/').at(-1));
  console.log(JSON.stringify({ title: 'Example #' + number, state: 'OPEN', author: { login: number === 1 ? 'rob' : 'other' } }));
} else {
  const endpoint = args.includes('--jq') ? args[1] : args[3].split('?')[0];
  const parts = endpoint.split('/');
  const n = Number(parts[4]);
  const data = endpoint === 'user' ? { login: 'rob' } : parts[5] === 'timeline' ? [f.timeline[n]] :
    parts[5] === 'comments' ? [f.comments[n]] : f.pulls[n];
  console.log(args.includes('--jq') ? data.login : JSON.stringify(data));
}
`, { mode: 0o700 });
  await writeFile(codex, `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(deliveries)}, JSON.stringify({
  chat: args[args.indexOf('--thread') + 1], message: args[args.indexOf('--message') + 1]
}) + '\\n');
`, { mode: 0o700 });

  let app;
  async function start() {
    app = spawn(process.execPath, [new URL('../app.js', import.meta.url).pathname], {
      env: { ...process.env, PR_CHAT_PORT: String(port), PR_CHAT_STATE_DIR: join(temp, 'state'), PR_CHAT_LEGACY: legacy,
        PR_CHAT_GH: gh, PR_CHAT_CODEX: codex, PR_CHAT_NOTIFIER: join(temp, 'disabled-notifier'),
        PR_CHAT_BATCH_MS: '100', PR_CHAT_POLL_MS: '150' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await Promise.race([once(app.stdout, 'data'), once(app, 'exit').then(([status]) => { throw new Error('App exited ' + status); })]);
  }
  async function stop() {
    const exited = once(app, 'exit');
    app.kill();
    await exited;
    app = null;
  }
  async function link(url, chat) {
    const response = await fetch(origin + '/api/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ pr: url, chat }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  async function waitFor(predicate) {
    const response = await fetch(origin + '/stream', { signal: AbortSignal.timeout(6000) });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Dashboard stream ended');
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const view = JSON.parse(buffer.slice(6, end));
          buffer = buffer.slice(end + 2);
          if (predicate(view)) return view;
        }
      }
    } finally {
      await reader.cancel();
    }
  }

  try {
    await start();
    await link(authorURL, authorChat);
    await link(`https://github.com/${repo}/pull/2`, reviewerChat);
    const initial = await waitFor(view => view.links.length === 2 && view.delivery.lastPoll);
    assert.equal(initial.delivery.mode, 'polling');
    assert.equal(initial.relay.status, 'unpaired');
    const cutover = await fetch(origin + '/api/cutover', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}',
    });
    assert.equal(cutover.status, 409);
    const timestamp = new Date().toISOString();
    const review = id => ({ id, event: 'reviewed', state: 'changes_requested', submitted_at: timestamp, user: { login: 'colleague' } });
    github.timeline[1].push(review(7), review(12));
    github.comments[1].push({ id: 15, created_at: timestamp, user: { login: 'colleague' } });
    github.timeline[2].push({ id: 18, event: 'review_requested', requested_reviewer: { login: 'rob' }, created_at: timestamp });
    github.pulls[2].requested_reviewers.push({ login: 'rob' });
    await publish();
    await waitFor(view => view.events.filter(event => event.status === 'queued').length === 3);
    await stop();
    await start();
    await waitFor(view => view.delivery.lastPoll);
    github.pulls[1] = { ...pull(1), state: 'closed', merged: true, closed_at: new Date().toISOString() };
    await publish();
    const final = await waitFor(view => view.links.some(link => link.number === 1 && link.status === 'merged'));
    assert.equal(final.links.find(link => link.number === 2).status, 'open');
    const rows = (await readFile(deliveries, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.every(row => row.chat === authorChat || row.chat === reviewerChat));
    const authorMessages = rows.filter(row => row.chat === authorChat).map(row => row.message).join('\n');
    const feedbackLinks = Array.from(authorMessages.matchAll(/#(?:pullrequestreview-\d+|discussion_r\d+)/g), match => match[0]);
    assert.deepEqual(feedbackLinks.sort(), ['#discussion_r15', '#pullrequestreview-12']);
    const reviewerMessages = rows.filter(row => row.chat === reviewerChat);
    assert.equal(reviewerMessages.length, 1);
    assert.match(reviewerMessages[0].message, /Keep the review read-only/);

    const setPolling = minutes => fetch(origin + '/api/polling', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ minutes }),
    });
    assert.equal((await setPolling(0)).status, 400);
    assert.equal((await setPolling(2.5)).status, 400);
    assert.equal((await setPolling(2)).status, 200);
    await waitFor(view => view.delivery.interval === 120_000);
    await stop();
    await start();
    const restarted = await waitFor(view => view.delivery.lastPoll);
    assert.equal(restarted.delivery.interval, 120_000);
    assert.equal(restarted.delivery.mode, 'polling');
    const reviewerLink = restarted.links.find(link => link.number === 2);
    const stopWatching = await fetch(origin + '/api/links/' + reviewerLink.id, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}',
    });
    assert.equal(stopWatching.status, 200);
    const history = await waitFor(view => view.links.some(link => link.number === 2 && link.status === 'stopped'));
    assert.equal(history.links.find(link => link.number === 2).thread, reviewerChat);
  } finally {
    if (app) await stop();
    await rm(temp, { recursive: true, force: true });
  }
});
