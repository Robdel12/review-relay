import { createMachine, defineMachine, z } from '@robdel12/cricket';

const empty = z.strictObject({});
const time = z.number().int().nonnegative();
const at = z.strictObject({ at: time });
const maxDeliveryAttempts = 5;
const end = (target) => ({ target, context: ({ event }) => ({ ended: event.at }) });

export const watch = defineMachine(
  createMachine({
    id: 'review-watch',
    version: '1',
    schemas: { events: { stopped: at, closed: at, merged: at } },
    initial: 'open',
    context: { ended: null },
    states: {
      open: {
        on: {
          stopped: end('stopped'),
          closed: end('closed'),
          merged: end('merged'),
        },
      },
      stopped: { type: 'final' },
      closed: { type: 'final' },
      merged: { type: 'final' },
    },
  }),
);

const sentAt = ({ context, event }) => Math.max(event.at, (context.sentAt ?? 0) + 1);

const queued = {
  target: 'queued',
  context: ({ context, event }) => ({
    attempts: context.attempts + 1,
    ready: event.at,
    sentAt: sentAt({ context, event }),
  }),
};

const retry = {
  target: 'pending',
  context: ({ event }) => ({ attempts: 0, ready: event.at }),
};

export const delivery = defineMachine(
  createMachine({
    id: 'review-delivery',
    version: '1',
    schemas: {
      events: {
        accepted: at,
        delivered: at,
        cancelled: empty,
        archived: empty,
        retry: at,
        rejected: z.strictObject({ at: time, watchOpen: z.boolean(), timedOut: z.boolean() }),
      },
    },
    initial: 'pending',
    context: { attempts: 0, ready: 0, sentAt: null },
    states: {
      pending: {
        on: {
          accepted: queued,
          delivered: { target: 'delivered', context: (args) => ({ sentAt: sentAt(args) }) },
          cancelled: { target: 'skipped' },
          archived: { target: 'archived' },
          rejected: ({ context, event }) => {
            const attempts = context.attempts + 1;
            const ready = event.at + Math.min(10_000 * 2 ** attempts, 180_000);
            const target = !event.watchOpen
              ? 'skipped'
              : event.timedOut || attempts >= maxDeliveryAttempts
                ? 'failed'
                : undefined;
            return { target, context: { attempts, ready } };
          },
        },
      },
      failed: { on: { retry, cancelled: { target: 'skipped' } } },
      queued: { on: { retry } },
      delivered: { on: { retry } },
      // A call already in flight can report acceptance after the watch was stopped.
      skipped: { on: { accepted: queued } },
      archived: { type: 'final' },
      linked: { type: 'final' },
    },
  }),
);

export async function watchTransition({ status, ended }, event) {
  const snapshot = watch.machine.resolveState({ value: status, context: { ended } });
  const result = await watch.transition(snapshot, event);
  return Object.freeze({ status: result.snapshot.value, ended: result.snapshot.context.ended });
}

export async function initialWatch(status, at) {
  const { snapshot } = await watch.initial();
  const initial = { status: snapshot.value, ended: snapshot.context.ended };
  return status === initial.status
    ? Object.freeze(initial)
    : watchTransition(initial, { type: status, at });
}

export async function deliveryTransition({ status, attempts, ready, sent_at }, event) {
  const snapshot = delivery.machine.resolveState({
    value: status,
    context: { attempts, ready, sentAt: sent_at },
  });
  const result = await delivery.transition(snapshot, event);
  return Object.freeze({ status: result.snapshot.value, ...result.snapshot.context });
}

export const isRetryable = (status) =>
  delivery.states.includes(status) &&
  delivery.machine.resolveState({ value: status }).can({ type: 'retry', at: 0 });
