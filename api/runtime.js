import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startCricketApp } from '@robdel12/cricket';
import { createAgents } from './adapters/agents.js';
import { createGitHub } from './adapters/github.js';
import { createRelay } from './adapters/relay.js';
import { reviewDatabase, stateDirectory } from './database.js';
import { createDashboard } from './domains/reviews/dashboard.js';
import { createReviewStore, importLegacyWatches } from './domains/reviews/reviews.store.js';
import { createReviewApp } from './index.js';
import { startReviewWorker } from './workers/local.js';

export async function startReviewRelay(env = process.env) {
  const home = homedir();
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const directory = stateDirectory(env);
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
  let origin;
  const workerLifetime = new AbortController();
  const app = createReviewApp({
    database: reviewDatabase(directory),
    origin: () => origin,
    async setup({ db, logger }) {
      await db.migrate.latest();
      const store = createReviewStore(db);
      await importLegacyWatches(store, legacy);

      let worker;
      const dependencies = {
        config,
        store,
        relay: createRelay(store),
        dashboard: createDashboard((error) =>
          logger.warn('dashboard.update.failed', { error: error.name }),
        ),
        github: createGitHub(env.PR_CHAT_GH || '/opt/homebrew/bin/gh'),
        agents: createAgents({
          codex:
            env.PR_CHAT_CODEX || join(home, '.codex/packages/app-server-daemon/current/bin/codex'),
          codexHome,
          codexDefaultSkill: env.PR_CHAT_CODEX_REVIEW_SKILL,
          claude: env.PR_CHAT_CLAUDE || join(home, '.local/bin/claude'),
          claudeHome: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
          notifier: env.PR_CHAT_NOTIFIER || '/opt/homebrew/bin/terminal-notifier',
          opener: env.PR_CHAT_OPEN || '/usr/bin/open',
          origin: () => origin,
        }),
        polling: { checking: false, error: false, lastPoll: null },
        discoveryStatus: { result: null },
        wake: {
          discoverAt: (at) => worker.discoverAt(at),
          pollAt: (at) => worker.pollAt(at),
          deliverAt: (at) => worker.deliverAt(at),
          notify: (id, reason) => worker.notify(id, reason),
        },
      };
      // Both runtimes share the HTTP app's store so one SQLite connection serializes transactions.
      worker = await startReviewWorker(
        createReviewApp({ setup: () => ({ dependencies }) }),
        workerLifetime.signal,
      );
      return { dependencies: { ...dependencies, worker }, cleanup: worker.cleanup };
    },
    onShutdown({ dependencies: { relay } }) {
      workerLifetime.abort();
      relay.close();
    },
  });
  const server = await startCricketApp(app, {
    host: '127.0.0.1',
    port: Number(env.PR_CHAT_PORT || 4317),
  });
  origin = server.origin;

  const { reviews } = server.services;
  try {
    await reviews.connectRelay();
    await Promise.all([
      reviews.schedulePoll(0),
      reviews.scheduleDelivery(),
      reviews.discovery.schedule(0),
    ]);
  } catch (error) {
    await server.stop('startup failure');
    throw error;
  }

  console.log(`Review Relay is available at ${origin}`);
  server.dependencies.worker.run().catch(async (error) => {
    server.logger.error('worker.stopped', { error: error.name });
    process.exitCode = 1;
    await server.stop('worker failure').catch((error) => {
      server.logger.error('shutdown.failed', { error: error.name });
    });
  });
  return server;
}
