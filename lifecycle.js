import { createMachine, transition } from 'xstate';

const maxDeliveryAttempts = 5;

const watch = createMachine({
  initial: 'open',
  states: {
    open: {
      on: {
        stopped: { target: 'stopped' },
        closed: { target: 'closed' },
        merged: { target: 'merged' },
      },
    },
    stopped: { type: 'final' },
    closed: { type: 'final' },
    merged: { type: 'final' },
  },
});

const delivery = createMachine({
  initial: 'pending',
  states: {
    pending: {
      on: {
        accepted: { target: 'queued' },
        cancelled: { target: 'skipped' },
        archived: { target: 'archived' },
        rejected: ({ event }) => {
          if (!event.watchOpen) return { target: 'skipped' };
          if (event.timedOut || event.attempts >= maxDeliveryAttempts) return { target: 'failed' };
        },
      },
    },
    failed: { on: { retry: { target: 'pending' }, cancelled: { target: 'skipped' } } },
    queued: { type: 'final' },
    skipped: { type: 'final' },
    archived: { type: 'final' },
  },
});

function nextStatus(machine, status, event) {
  const [next] = transition(machine, machine.resolveState({ value: status }), event);
  return next.value;
}

export const watchStatus = (status, event) => nextStatus(watch, status, { type: event });
export const deliveryStatus = (status, event) => nextStatus(delivery, status, event);

export function deliveryOutcome(entry, event, now) {
  const attempts = entry.attempts + 1;
  const status = deliveryStatus(entry.status, { ...event, attempts });
  const delay = event.type === 'rejected' ? Math.min(10_000 * 2 ** attempts, 180_000) : 0;
  return { status, ready: now + delay, attempts };
}
