import { randomUUID } from 'node:crypto';
import { loginName } from '../../../protocol.js';
import { prURL } from './feedback.js';
import { InputError } from './input-error.js';
import { initialWatch } from './reviews.machine.js';

const setting = 'review-discovery';

async function preference(rows) {
  return JSON.parse((await rows.setting(setting)) ?? 'null');
}

export function createDiscovery({ store, github, agents, interval, wake, watchChanged, changed }) {
  let checking = false;
  let lastCheck = null;
  let error = false;

  async function view(rows) {
    const config = await preference(rows);
    if (!config) return null;
    const unresolved = await rows.unresolvedReviewStart(config.repo);
    return { ...config, lastCheck, error, unresolved };
  }

  function schedule(delay) {
    return store.transaction(async (rows) => {
      const enabled = !checking && (await preference(rows));
      wake.discoverAt(enabled ? Date.now() + (delay ?? (await interval(rows))) : null);
    });
  }

  async function configure({ provider, cwd: path }) {
    let next = null;
    if (provider !== 'off') {
      const checkout = await github.checkout(path);
      let login;
      try {
        login = await github.login();
        if (!loginName.test(login)) throw new Error('Invalid login');
      } catch {
        throw new InputError(
          'Check your GitHub CLI login before enabling fresh review chats.',
          502,
        );
      }
      next = { ...checkout, login, provider };
    }

    const updated = await store.transaction(async (rows) => {
      const current = await preference(rows);
      if (
        next &&
        current?.cwd === next.cwd &&
        current.login === next.login &&
        current.provider === next.provider &&
        current.repo === next.repo
      )
        return false;
      await rows.set(setting, JSON.stringify(next && { ...next, since: Date.now() }));
      return true;
    });
    if (updated) {
      lastCheck = null;
      error = false;
      await schedule(0);
      changed();
    }
  }

  async function start(config, number) {
    const { repo, login, cwd, provider } = config;
    const fields = { repo, number };
    if (await store.transaction((rows) => rows.trackedReview(fields))) return null;
    const pr = await github.freshRequest(config, number);
    if (!pr) return null;

    const created = Date.now();
    const id = randomUUID();
    const claimed = await store.transaction(async (rows) => {
      if (JSON.stringify(await preference(rows)) !== JSON.stringify(config)) return false;
      if ((await rows.openWatches()).length >= 100 || (await rows.trackedReview(fields))) {
        return false;
      }
      await rows.addReviewStart({ ...fields, created, status: 'starting' });
      return true;
    });
    if (!claimed) return null;

    try {
      const { thread, attachId } = await agents.startReview({
        provider,
        cwd,
        title: `🔎 PR: ${pr.title} (#${number})`,
        prompt: `Review PR ${prURL(fields)}. Confirm GitHub still requests my review. Keep the review read-only and report your findings in this chat. Ask me before posting to GitHub or changing the pull request.`,
      });
      const linked = await store.transaction(async (rows) => {
        const current = await rows.openWatch(repo, number);
        if (current?.thread === thread && current.provider === provider) {
          if (attachId) await rows.setAttachId(current.id, attachId);
        } else if (!current) {
          await rows.addWatch({
            ...fields,
            id,
            login,
            thread,
            title: pr.title,
            worktree: null,
            role: 'reviewer',
            provider,
            attach_id: attachId ?? null,
            created,
            ...(await initialWatch('open', created)),
          });
        }
        await rows.setReviewStart(fields, 'started');
        return current?.thread === thread ? current.id : current ? null : id;
      });
      await watchChanged();
      return linked;
    } catch (error) {
      await store.transaction((rows) => rows.setReviewStart(fields, 'failed'));
      throw error;
    }
  }

  async function run(logger, notify) {
    if (checking) return;
    checking = true;
    try {
      const config = await store.transaction(preference);
      if (!config) return;
      const checkout = await github.checkout(config.cwd);
      if (
        checkout.cwd !== config.cwd ||
        checkout.repo !== config.repo ||
        (await github.login()) !== config.login
      ) {
        throw new Error('Review discovery configuration changed');
      }
      const numbers = await github.outstandingReviews(config);
      let failed = false;
      for (const number of numbers) {
        try {
          const id = await start(config, number);
          if (id) await notify(id);
        } catch {
          failed = true;
          logger.warn('review-discovery.pr.failed', { number });
        }
      }
      lastCheck = Date.now();
      error = failed;
    } catch {
      error = true;
      logger.warn('review-discovery.check.failed');
    } finally {
      checking = false;
      await schedule();
      changed();
    }
  }

  return Object.freeze({ configure, view, schedule, run });
}
