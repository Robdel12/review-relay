import { randomUUID } from 'node:crypto';
import { defaultReviewSkill, loginName, repoName, skillName } from '../../../protocol.js';
import { prURL } from './feedback.js';
import { InputError } from './input-error.js';
import { initialWatch } from './reviews.machine.js';

const discoveryKey = 'review-discovery';

async function preference(rows) {
  return JSON.parse((await rows.setting(discoveryKey)) ?? 'null');
}

function sameTarget(current, next) {
  if (!current || !next) return current === next;
  return (
    current.cwd === next.cwd &&
    current.login === next.login &&
    current.provider === next.provider &&
    current.repo === next.repo
  );
}

function sameConfiguration(left, right) {
  return sameTarget(left, right) && left?.since === right?.since;
}

async function saveReviewLink(rows, watch) {
  const current = await rows.openWatch(watch.repo, watch.number);
  if (!current) {
    await rows.addWatch({ ...watch, ...(await initialWatch('open', watch.created)) });
    return watch.id;
  }
  if (current.thread !== watch.thread) return null;
  if (current.provider === watch.provider && watch.attach_id) {
    await rows.setAttachId(current.id, watch.attach_id);
  }
  return current.id;
}

export function createDiscovery({
  status,
  store,
  github,
  agents,
  interval,
  wake,
  watchChanged,
  changed,
}) {
  function resultFor(config) {
    return sameConfiguration(status.result?.config, config) ? status.result : null;
  }

  async function view(rows) {
    const config = await preference(rows);
    if (!config) return null;
    const result = resultFor(config);
    const unresolved = await rows.unresolvedReviewStart(config.repo);
    return {
      ...config,
      lastCheck: result?.lastCheck ?? null,
      error: result?.error ?? false,
      unresolved,
    };
  }

  function schedule(delay, checkedConfig) {
    return store.transaction(async (rows) => {
      const config = await preference(rows);
      if (!config) return wake.discoverAt(null);
      const targetChanged =
        checkedConfig !== undefined && !sameConfiguration(checkedConfig, config);
      const wait = targetChanged ? 0 : (delay ?? (await interval(rows)));
      wake.discoverAt(Date.now() + wait);
    });
  }

  async function discoveryTarget({ provider, cwd, repo }) {
    if (provider === 'off') return null;
    const selectedRepo = repo?.trim().toLowerCase();
    if (selectedRepo && !repoName.test(selectedRepo)) {
      throw new InputError('Enter the GitHub repository as owner/repo.');
    }
    const checkout = await github.checkout(cwd);
    if (selectedRepo && selectedRepo !== checkout.repo) {
      throw new InputError('The repository must match the checkout’s GitHub origin.');
    }
    let login;
    try {
      login = await github.login();
      if (!loginName.test(login)) throw new Error('Invalid login');
    } catch {
      throw new InputError('Check your GitHub CLI login before enabling fresh review chats.', 502);
    }
    return { ...checkout, login, provider };
  }

  async function configure({ skill, ...target }) {
    const selectedSkill = skill === undefined ? undefined : skill.trim() || defaultReviewSkill;
    if (selectedSkill && !skillName.test(selectedSkill)) {
      throw new InputError('Enter a skill name using letters, numbers, hyphens, or underscores.');
    }
    const next = await discoveryTarget(target);
    const targetChanged = await store.transaction(async (rows) => {
      if (selectedSkill && selectedSkill !== (await rows.reviewSkill())) {
        await rows.setReviewSkill(selectedSkill);
      }
      if (sameTarget(await preference(rows), next)) return false;
      await rows.set(discoveryKey, JSON.stringify(next && { ...next, since: Date.now() }));
      return true;
    });
    if (targetChanged) await schedule(0);
    changed();
  }

  async function startReview(config, number) {
    const { repo, login, cwd, provider } = config;
    const fields = { repo, number };
    if (await store.transaction((rows) => rows.trackedReview(fields))) return null;
    const pr = await github.freshRequest(config, number);
    if (!pr) return null;

    const created = Date.now();
    const id = randomUUID();
    const selectedSkill = await store.transaction(async (rows) => {
      if (!sameConfiguration(await preference(rows), config)) return false;
      if (!(await rows.hasWatchCapacity()) || (await rows.trackedReview(fields))) {
        return false;
      }
      await rows.addReviewStart({ ...fields, created, status: 'starting' });
      return rows.reviewSkill();
    });
    if (!selectedSkill) return null;

    try {
      const { thread, attachId } = await agents.startReview({
        provider,
        cwd,
        skillName: selectedSkill,
        title: `🔎 PR: ${pr.title} (#${number})`,
        prompt: `Review PR ${prURL(fields)}. Confirm GitHub still requests my review. Keep the review read-only and report your findings in this chat. Ask me before posting to GitHub or changing the pull request.`,
      });
      const watch = {
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
      };
      const linked = await store.transaction(async (rows) => {
        const linkedId = await saveReviewLink(rows, watch);
        await rows.setReviewStart(fields, 'started');
        if (linkedId) {
          const linkedAt = Date.now();
          await rows.addDelivery({
            id: `${linkedId}:${randomUUID()}`,
            link: linkedId,
            kind: 'review-started',
            status: 'linked',
            received: linkedAt,
            ready: linkedAt,
          });
        }
        return linkedId;
      });
      await watchChanged();
      return linked;
    } catch (error) {
      await store.transaction((rows) => rows.setReviewStart(fields, 'failed'));
      throw error;
    }
  }

  async function run(logger, notify) {
    let config;
    try {
      config = await store.transaction(preference);
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
          const id = await startReview(config, number);
          if (id) await notify(id);
        } catch {
          failed = true;
          logger.warn('review-discovery.pr.failed', { number });
        }
      }
      status.result = { config, lastCheck: Date.now(), error: failed };
    } catch {
      if (config) {
        status.result = { config, lastCheck: resultFor(config)?.lastCheck ?? null, error: true };
      }
      logger.warn('review-discovery.check.failed');
    } finally {
      await schedule(undefined, config);
      changed();
    }
  }

  return Object.freeze({ configure, view, schedule, run });
}
