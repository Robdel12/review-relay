import { createInbox } from './inbox.js';
import { InputError } from './input-error.js';
import { isRetryable } from './reviews.machine.js';
import { createWatches } from './watches.js';

export function createReviewsService({
  store,
  config,
  github,
  agents,
  dashboard,
  relay,
  wake,
  polling,
  logger,
}) {
  const mode = async (rows) => (await rows.setting('delivery-mode')) ?? 'polling';
  const interval = async (rows) =>
    Number((await rows.setting('poll-interval-ms')) ?? config.pollMs);
  const view = () =>
    store.transaction(async (rows) => ({
      links: (await rows.dashboardWatches()).map((link) => ({
        ...link,
        subscribed: link.status === 'open' && relay.subscribed(link.id),
      })),
      events: (await rows.dashboardDeliveries()).map(({ watchStatus, ...event }) => ({
        ...event,
        canRetry: watchStatus === 'open' && isRetryable(event.status),
      })),
      delivery: {
        mode: await mode(rows),
        interval: await interval(rows),
        lastPoll: polling.lastPoll,
        error: polling.error,
      },
      relay: { ...relay.view(), url: (await rows.setting('relay-url')) ?? null },
    }));
  const changed = () => void dashboard.publish(view);

  function scheduleDelivery() {
    return store.transaction(async (rows) => wake.deliverAt(await rows.nextCodexDeadline()));
  }
  function schedulePoll(delay) {
    return store.transaction(async (rows) => {
      const enabled =
        !polling.checking && (await mode(rows)) === 'polling' && (await rows.openWatches()).length;
      wake.pollAt(enabled ? Date.now() + (delay ?? (await interval(rows))) : null);
    });
  }
  async function watchChanged(delay) {
    await Promise.all([schedulePoll(delay), scheduleDelivery(), relay.sync()]);
    changed();
  }
  const inbox = createInbox({
    store,
    batchMs: config.batchMs,
    changed,
    scheduleDelivery,
    notify: wake.notify,
  });
  const watches = createWatches({ store, github, watchChanged });

  async function setPolling(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      throw new InputError('Enter a whole number from 1 to 60 minutes.');
    }
    const updated = await store.transaction(async (rows) => {
      await rows.set('poll-interval-ms', String(minutes * 60_000));
      return { interval: await interval(rows) };
    });
    await schedulePoll();
    changed();
    return updated;
  }

  async function cutover() {
    await store.transaction(async (rows) => {
      const { status, lastWebhook } = relay.view();
      if (
        status !== 'connected' ||
        !lastWebhook ||
        (await rows.openWatches()).some((link) => !relay.subscribed(link.id))
      ) {
        throw new InputError(
          'Wait for a signed GitHub delivery and active subscriptions before switching to push.',
          409,
        );
      }
      if (polling.checking)
        throw new InputError('A GitHub check is running. Try again when it finishes.', 409);
      await rows.set('delivery-mode', 'push');
    });
    await schedulePoll();
    changed();
  }

  async function connectRelay(reset) {
    await relay.connect(
      {
        changed,
        logger,
        async receive(events) {
          const ids = await inbox.receive(events, { fromRelay: true });
          await scheduleDelivery();
          return ids;
        },
      },
      reset,
    );
  }

  async function pair(input) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      throw new InputError('Enter the HTTPS URL of the relay.');
    }
    const local =
      config.allowLocalRelay && url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if (
      (!local && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new InputError('Enter the relay origin without a path, query, or credentials.');
    }
    if (!/^[a-f0-9]{64}$/.test(input.token)) {
      throw new InputError('Use the 64-character hexadecimal bridge token.');
    }
    await store.transaction(async (rows) => {
      await rows.set('relay-url', url.origin);
      await rows.set('relay-token', input.token);
    });
    await connectRelay(true);
  }

  function beginPoll() {
    return store.transaction(async (rows) => {
      if ((await mode(rows)) !== 'polling' || polling.checking) return [];
      const links = await rows.openWatches();
      if (links.length) {
        polling.checking = true;
        polling.error = false;
      }
      return links;
    });
  }
  async function finishPoll(error) {
    polling.error = error;
    if (!error) polling.lastPoll = Date.now();
    polling.checking = false;
    await watchChanged();
  }

  return Object.freeze({
    ...watches,
    retryDelivery: inbox.retryDelivery,
    takeClaudeFeedback: inbox.takeClaudeFeedback,
    view,
    subscribe: () => dashboard.subscribe(view),
    setPolling,
    pair,
    cutover,
    connectRelay,
    scheduleDelivery,
    schedulePoll,
    beginPoll,
    finishPoll,
    ingest: inbox.receive,
    nextBatch: inbox.nextBatch,
    recordAttempt: inbox.recordAttempt,
    changed,
    github,
    agents,
    legacy: config.legacy,
    watchForNotice: (id) => store.transaction((rows) => rows.watch(id)),
  });
}
