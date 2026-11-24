import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startCricketApp } from '@robdel12/cricket';
import { createAgents } from './adapters/agents.js';
import { createGitHub } from './adapters/github.js';
import { createRelay } from './adapters/relay.js';
import { createDashboard } from './domains/reviews/dashboard.js';
import { openReviewStore } from './domains/reviews/reviews.store.js';
import { createReviewApp } from './index.js';
import { startReviewWorker } from './workers/local.js';

export async function startReviewRelay(env = process.env) {
  const home = homedir();
  const directory = env.PR_CHAT_STATE_DIR || join(home, '.local/state/pr-chat');
  const legacyPath = env.PR_CHAT_LEGACY || join(home, '.local/state/pr-chat-watch/links.json');
  const legacy = existsSync(legacyPath) ? JSON.parse(readFileSync(legacyPath, 'utf8')) : {};
  const config = Object.freeze({
    legacy,
    pollMs: Math.max(Number(env.PR_CHAT_POLL_MS) || 120_000, 100),
    batchMs: Number(env.PR_CHAT_BATCH_MS || 12_000),
    allowLocalRelay: env.PR_CHAT_ALLOW_HTTP === '1',
  });

  process.umask(0o077);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = await openReviewStore(join(directory, 'inbox.sqlite'), legacy);
  const dashboard = createDashboard((error) =>
    console.error('Dashboard update failed', error.name),
  );
  const relay = createRelay(store);
  let origin;
  let worker;
  let server;
  const dependencies = {
    config,
    store,
    dashboard,
    relay,
    github: createGitHub(env.PR_CHAT_GH || '/opt/homebrew/bin/gh'),
    agents: createAgents({
      codex: env.PR_CHAT_CODEX || join(home, '.codex/packages/app-server-daemon/current/bin/codex'),
      notifier: env.PR_CHAT_NOTIFIER || '/opt/homebrew/bin/terminal-notifier',
      origin: () => origin,
    }),
    polling: { checking: false, error: false, lastPoll: null },
    wake: {
      pollAt: (at) => worker.pollAt(at),
      deliverAt: (at) => worker.deliverAt(at),
      notify: (id, reason) => worker.notify(id, reason),
    },
  };
  let closingStore;
  const cleanup = () => (closingStore ??= store.close());

  try {
    worker = await startReviewWorker(createReviewApp({ dependencies }));
    server = await startCricketApp(
      createReviewApp({
        dependencies,
        origin: () => origin,
        async onShutdown() {
          relay.close();
          dashboard.close();
          await worker.cleanup();
        },
        cleanup,
      }),
      { host: '127.0.0.1', port: Number(env.PR_CHAT_PORT || 4317) },
    );
    origin = server.origin;
    const { reviews } = server.services;
    await reviews.connectRelay();
    await Promise.all([reviews.schedulePoll(0), reviews.scheduleDelivery()]);
    console.log(`Review Relay is available at ${origin}`);
    worker.run().catch(async (error) => {
      console.error('Review worker stopped', error.name);
      process.exitCode = 1;
      await server.stop('worker failure').catch((error) => {
        console.error('Review Relay shutdown failed', error.name);
      });
    });
    return server;
  } catch (error) {
    try {
      if (server) await server.stop('startup failure');
      else await worker?.cleanup();
    } finally {
      await cleanup();
    }
    throw error;
  }
}
