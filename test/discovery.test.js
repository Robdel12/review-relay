import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { startReviewRelay } from '../api/runtime.js';

test('starts fresh review chats, links the actual agent session, and remembers launches', {
  timeout: 20_000,
}, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'rr-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = 'example/example';
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', directory, ...args]);
  git('init', '--quiet');
  git('remote', 'add', 'origin', `https://github.com/${repo}.git`);

  const fixture = join(directory, 'github.json');
  const gh = join(directory, 'gh');
  const codex = join(directory, 'codex');
  const claude = join(directory, 'claude');
  const skill = join(directory, 'SKILL.md');
  const codexHome = join(directory, 'codex-home');
  const claudeHome = join(directory, 'claude-home');
  const skillName = 'review-checklist';
  const customCodexSkill = join(codexHome, 'skills', skillName, 'SKILL.md');
  const customClaudeSkill = join(claudeHome, 'skills', skillName, 'SKILL.md');
  for (const path of [customCodexSkill, customClaudeSkill]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# Custom review skill\n');
  }
  const socket = join(directory, 'codex.sock');
  const claudeLog = join(directory, 'claude.json');
  const codexLog = join(directory, 'codex.jsonl');
  const codexId = randomUUID();
  const fallbackId = randomUUID();
  const codexThreads = [codexId, fallbackId].values();
  const claudeId = randomUUID();
  const attachId = claudeId.slice(0, 8);
  const github = {};
  async function publish() {
    const next = `${fixture}.next`;
    await writeFile(next, JSON.stringify(github));
    await rename(next, fixture);
  }
  function request(number, at, { previous = false, team = false } = {}) {
    const reviewer = { login: 'rob' };
    github[number] = {
      pull: {
        title: `Test PR ${number}`,
        number,
        state: 'open',
        user: { login: 'someone' },
        requested_reviewers: team ? [] : [reviewer],
      },
      timeline: [
        ...(previous
          ? [{ event: 'reviewed', user: reviewer, submitted_at: new Date(at - 1000).toISOString() }]
          : []),
        {
          id: number * 100 + (github[number]?.timeline.length ?? 0),
          event: 'review_requested',
          ...(team ? { requested_team: { slug: 'dev' } } : { requested_reviewer: reviewer }),
          created_at: new Date(at).toISOString(),
        },
      ],
    };
  }
  const executable = (path, source) =>
    writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  request(1, Date.now() - 100_000);
  await publish();
  await Promise.all([
    writeFile(skill, '# Test review skill\n'),
    executable(
      gh,
      `
      const { readFileSync } = require('node:fs');
      const fixture = JSON.parse(readFileSync(${JSON.stringify(fixture)}, 'utf8'));
      const [, , command, flag, host, endpoint, ...args] = process.argv;
      if (command !== 'api' || flag !== '--hostname' || host !== 'github.com') process.exit(1);
      let body;
      if (endpoint === 'user') body = { login: 'rob' };
      if (endpoint.startsWith('search/issues?q=')) {
        const q = new URLSearchParams(endpoint.split('?')[1]).get('q');
        if (!q.includes('repo:example/example') || !q.includes('review-requested:rob')) process.exit(2);
        body = { items: Object.keys(fixture).map((key) => ({ number: Number(key) })) };
      }
      const pr = endpoint.startsWith('repos/') ? endpoint.split('/')[4].split('?')[0] : null;
      if (pr && fixture[pr]) body = endpoint.includes('/timeline') ? fixture[pr].timeline : fixture[pr].pull;
      if (!body) process.exit(3);
      console.log(JSON.stringify(args.includes('--slurp') ? [body] : body));
    `,
    ),
    executable(
      claude,
      `
      const { appendFileSync } = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === '--bg') {
        appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify(args) + '\\n');
        console.error('backgrounded · ${attachId}');
        console.error('  claude attach ${attachId}    open in this terminal');
      } else if (args.join(' ') === 'agents --json --all') {
        console.log(JSON.stringify([{ id: '${attachId}', kind: 'background', cwd: process.cwd(), sessionId: '${claudeId}' }]));
      } else process.exit(1);
    `,
    ),
    executable(
      codex,
      `
      const { appendFileSync } = require('node:fs');
      appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    `,
    ),
  ]);

  const requests = [];
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  server.on('connection', (connection) => {
    connection.on('message', (raw) => {
      const message = JSON.parse(raw);
      requests.push(message);
      if (message.id === undefined) return;
      const result =
        message.method === 'thread/start' ? { thread: { id: codexThreads.next().value } } : {};
      connection.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(socket, resolve);
  });
  t.after(() => {
    for (const client of server.clients) client.terminate();
    server.close();
    return new Promise((resolve) => http.close(resolve));
  });

  const env = {
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    PR_CHAT_PORT: '0',
    PR_CHAT_STATE_DIR: join(directory, 'state'),
    PR_CHAT_LEGACY: join(directory, 'no-legacy'),
    PR_CHAT_NOTIFIER: join(directory, 'no-notifier'),
    PR_CHAT_POLL_MS: '150',
    PR_CHAT_BATCH_MS: '100',
    PR_CHAT_GH: gh,
    PR_CHAT_CODEX: codex,
    PR_CHAT_CODEX_SOCKET: socket,
    PR_CHAT_CODEX_REVIEW_SKILL: skill,
    PR_CHAT_CLAUDE: claude,
  };
  let app = await startReviewRelay(env);
  t.after(() => app?.stop('test'));
  async function post(path, body, status = 200) {
    const response = await fetch(`${app.origin}${path}`, {
      signal: t.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app.origin },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function waitFor(accept) {
    const cancel = new AbortController();
    const response = await fetch(`${app.origin}/stream`, {
      signal: AbortSignal.any([t.signal, cancel.signal]),
    });
    assert.equal(response.status, 200);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        assert.ok(!done, 'Dashboard closed');
        buffer += value;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const view = JSON.parse(buffer.slice(6, end));
          buffer = buffer.slice(end + 2);
          if (accept(view)) return view;
        }
      }
    } finally {
      cancel.abort();
      reader.releaseLock();
    }
  }

  const initial = await waitFor(() => true);
  assert.equal(initial.reviewDiscovery, null);
  assert.equal(initial.reviewSkill, 'pull-request-review');
  await post('/api/review-discovery', { provider: 'off', skill: '../review' }, 400);
  await post('/api/review-discovery', { provider: 'codex', cwd: '.' }, 400);
  await post(
    '/api/review-discovery',
    { provider: 'codex', cwd: directory, repo: 'example/other' },
    400,
  );
  await post('/api/review-discovery', {
    provider: 'codex',
    cwd: directory,
    repo: 'Example/Example',
  });
  const enabled = await waitFor((view) => view.reviewDiscovery?.lastCheck);
  assert.deepEqual(enabled.links, []);
  assert.equal(enabled.reviewDiscovery.repo, repo);

  const timestamp = Date.now();
  request(2, timestamp);
  request(3, timestamp, { previous: true });
  request(4, timestamp, { team: true });
  await publish();
  const codexView = await waitFor((view) => view.links.some(({ number }) => number === 2));
  assert.deepEqual(
    codexView.links.map(({ number, role, provider, thread }) => [number, role, provider, thread]),
    [[2, 'reviewer', 'codex', codexId]],
  );
  assert.deepEqual(
    requests.map(({ method }) => method),
    ['initialize', 'initialized', 'thread/start', 'thread/name/set', 'turn/start'],
  );
  assert.deepEqual(requests[2].params, { cwd: directory, model: 'gpt-6.2-sol' });
  assert.equal(requests[3].params.name, '🔎 PR: Test PR 2 (#2)');
  assert.equal(requests[4].params.threadId, codexId);
  assert.equal(requests[4].params.model, 'gpt-6.2-sol');
  assert.match(requests[4].params.input[0].text, /\$pull-request-review.*\/pull\/2.*read-only/);
  assert.deepEqual(requests[4].params.input[1], {
    type: 'skill',
    name: 'pull-request-review',
    path: skill,
  });

  await post('/api/review-discovery', { provider: 'codex', cwd: directory, skill: skillName });
  const updated = await waitFor((view) => view.reviewSkill === skillName);
  assert.equal(updated.reviewDiscovery.since, enabled.reviewDiscovery.since);
  request(2, Date.now());
  await publish();
  await waitFor((view) =>
    view.events.some(({ number, status }) => number === 2 && status === 'queued'),
  );
  const queued = JSON.parse(await readFile(codexLog, 'utf8'));
  assert.equal(queued[queued.indexOf('--thread') + 1], codexId);
  const followUp = queued[queued.indexOf('--message') + 1];
  assert.ok(followUp.includes(customCodexSkill));
  assert.match(followUp, /review-checklist skill.*read-only/);
  await post(`/api/links/${codexView.links[0].id}`, {});
  await post('/api/review-discovery', { provider: 'claude', cwd: directory });

  const claudeEnabled = await waitFor((view) => view.reviewDiscovery?.provider === 'claude');
  request(2, Date.now());
  request(5, Date.now());
  await publish();
  const after = await waitFor(
    (view) =>
      view.reviewDiscovery?.lastCheck > claudeEnabled.reviewDiscovery.since &&
      view.links.some(({ number }) => number === 5),
  );
  assert.deepEqual(
    after.links.map(({ number, status }) => [number, status]),
    [
      [5, 'open'],
      [2, 'stopped'],
    ],
  );
  assert.equal(after.links[0].thread, claudeId);
  assert.equal(after.links[0].attach_id, attachId);
  const args = JSON.parse(await readFile(claudeLog, 'utf8'));
  assert.deepEqual(args.slice(0, 6), [
    '--bg',
    '--name',
    '🔎 PR: Test PR 5 (#5)',
    '--model',
    'claude-opus-5-5',
    '--',
  ]);
  assert.match(args[6], /review-checklist.*\/pull\/5.*read-only/);
  assert.ok(args[6].includes(customClaudeSkill));

  await post('/api/review-discovery', {
    provider: 'codex',
    cwd: directory,
    skill: 'missing-review-skill',
  });
  request(6, Date.now());
  await publish();
  const fallback = await waitFor((view) => view.links.some(({ thread }) => thread === fallbackId));
  const fallbackInput = requests.at(-1).params.input;
  assert.equal(fallbackInput.length, 1);
  assert.match(fallbackInput[0].text, /^Review PR .*\/pull\/6.*read-only/);

  await app.stop('test restart');
  app = await startReviewRelay(env);
  const restarted = await waitFor((view) => view.reviewDiscovery?.lastCheck);
  assert.deepEqual(restarted.links, fallback.links);
  assert.equal(restarted.reviewSkill, 'missing-review-skill');
  assert.equal(requests.length, 10);
  assert.equal((await readFile(claudeLog, 'utf8')).trim().split('\n').length, 1);
  await post('/api/review-discovery', { provider: 'off', skill: ' ' });
  const disabled = await waitFor((view) => !view.reviewDiscovery);
  assert.equal(disabled.reviewSkill, 'pull-request-review');
});
