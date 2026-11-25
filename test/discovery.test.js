import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
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
  const claudeLog = join(directory, 'claude.json');
  const codexLog = join(directory, 'codex.jsonl');
  const noticeLog = join(directory, 'notices.jsonl');
  const notifier = join(directory, 'notifier');
  const codexId = randomUUID();
  const fallbackId = randomUUID();
  const rpcLog = join(directory, 'codex-rpc.jsonl');
  const projectId = 'example-project';
  await writeFile(rpcLog, '');
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
        if (fixture.searchUnavailable) process.exit(4);
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
      notifier,
      `
      const { appendFileSync } = require('node:fs');
      appendFileSync(${JSON.stringify(noticeLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
    `,
    ),
    executable(
      codex,
      `
      const { appendFileSync, readFileSync } = require('node:fs');
      const { createInterface } = require('node:readline');
      const args = process.argv.slice(2);
      if (args[0] === 'queue') {
        appendFileSync(${JSON.stringify(codexLog)}, JSON.stringify(args) + '\\n');
      } else if (args.join(' ') === 'app-server --listen stdio://') {
        if (process.env.CODEX_HOME !== ${JSON.stringify(codexHome)}) process.exit(2);
        const file = ${JSON.stringify(rpcLog)};
        const log = (row) => appendFileSync(file, JSON.stringify({ pid: process.pid, ...row }) + '\\n');
        const readLog = () => readFileSync(file, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
        const threads = ${JSON.stringify([codexId, fallbackId])};
        const results = {
          initialize: () => ({}),
          'project/list': () => ({
            data: [
              { id: 'unrelated', roots: [{ path: '/another/checkout' }] },
              { id: '${projectId}', roots: [{ path: process.cwd() }] },
            ],
            nextCursor: null,
          }),
          'thread/start': () => ({
            thread: { id: threads[readLog().filter((row) => row.method === 'thread/start').length] },
          }),
          'thread/name/set': () => ({}),
          'thread/read': ({ threadId }) => {
            const creator = readLog().find((row) => row.method === 'thread/name/set' && row.params.threadId === threadId);
            const closed = readLog().some((row) => row.pid === creator?.pid && row.method === 'closed');
            if (!closed) throw new Error('thread still has an active writer');
            return { thread: { id: threadId } };
          },
          'thread/queue/add': () => ({ queuedSubmission: {} }),
        };
        createInterface({ input: process.stdin })
          .on('line', (line) => {
            const message = JSON.parse(line);
            if (message.id === undefined) { log(message); return; }
            const result = results[message.method](message.params);
            log(message);
            console.log(JSON.stringify({ id: message.id, result }));
          })
          .on('close', () => log({ method: 'closed' }));
      } else process.exit(1);
    `,
    ),
  ]);

  const requests = async () => (await readFile(rpcLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const env = {
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    PR_CHAT_PORT: '0',
    PR_CHAT_STATE_DIR: join(directory, 'state'),
    PR_CHAT_LEGACY: join(directory, 'no-legacy'),
    PR_CHAT_NOTIFIER: notifier,
    PR_CHAT_POLL_MS: '150',
    PR_CHAT_BATCH_MS: '100',
    PR_CHAT_GH: gh,
    PR_CHAT_CODEX: codex,
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
  async function snapshot() {
    const response = await fetch(`${app.origin}/api/state`, { signal: t.signal });
    assert.equal(response.status, 200);
    return response.json();
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
  github.searchUnavailable = true;
  await publish();
  await post('/api/review-discovery', {
    provider: 'codex',
    cwd: directory,
    repo: 'Example/Example',
  });
  await waitFor((view) => view.reviewDiscovery?.error);
  assert.equal((await snapshot()).reviewDiscovery.error, true);
  delete github.searchUnavailable;
  await publish();
  const enabled = await waitFor(
    (view) => view.reviewDiscovery?.lastCheck && !view.reviewDiscovery.error,
  );
  const recovered = (await snapshot()).reviewDiscovery;
  assert.equal(recovered.error, false);
  assert.ok(recovered.lastCheck >= enabled.reviewDiscovery.lastCheck);
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
  const newReview = codexView.events.find((event) => event.kind === 'review-queued');
  assert.ok(newReview);
  assert.equal(newReview.number, 2);
  assert.equal(newReview.thread, codexId);
  assert.equal(newReview.status, 'linked');
  assert.equal(newReview.canRetry, false);
  await post(`/api/retry/${newReview.id}`, {}, 409);
  const first = await requests();
  assert.deepEqual(
    first.map(({ method }) => method),
    [
      'initialize',
      'initialized',
      'project/list',
      'thread/start',
      'thread/name/set',
      'closed',
      'initialize',
      'initialized',
      'thread/read',
      'thread/queue/add',
      'closed',
    ],
  );
  const created = first.find(({ method }) => method === 'thread/start');
  const named = first.find(({ method }) => method === 'thread/name/set');
  const firstPrompt = first.find(({ method }) => method === 'thread/queue/add');
  assert.deepEqual(created.params, {
    cwd: directory,
    model: 'gpt-6.2-sol',
    projectId,
    historyMode: 'paginated',
  });
  assert.equal(named.params.name, '🔎 PR: Test PR 2 (#2)');
  assert.notEqual(firstPrompt.pid, created.pid);
  assert.equal(firstPrompt.params.threadId, codexId);
  assert.match(firstPrompt.params.input[0].text, /\$pull-request-review.*\/pull\/2.*read-only/);
  assert.deepEqual(firstPrompt.params.input[1], {
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
  assert.deepEqual(queued.slice(0, 3), ['queue', '--thread', codexId]);
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
  const fallbackInput = (await requests()).findLast(({ method }) => method === 'thread/queue/add')
    .params.input;
  assert.equal(fallbackInput.length, 1);
  assert.match(fallbackInput[0].text, /^Review PR .*\/pull\/6.*read-only/);

  await app.stop('test restart');
  app = await startReviewRelay(env);
  const restarted = await waitFor((view) => view.reviewDiscovery?.lastCheck);
  assert.deepEqual(restarted.links, fallback.links);
  assert.equal(restarted.reviewSkill, 'missing-review-skill');
  assert.equal(restarted.events.find((event) => event.id === newReview.id).thread, codexId);
  const notices = (await readFile(noticeLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const newChatNotice = notices.find((args) => args.includes(`codex://threads/${codexId}`));
  assert.ok(newChatNotice?.includes('Open the chat in Codex to start the queued review.'));
  assert.equal((await requests()).filter(({ method }) => method === 'thread/queue/add').length, 2);
  assert.equal((await readFile(claudeLog, 'utf8')).trim().split('\n').length, 1);
  await post('/api/review-discovery', { provider: 'off', skill: ' ' });
  const disabled = await waitFor((view) => !view.reviewDiscovery);
  assert.equal(disabled.reviewSkill, 'pull-request-review');
});
