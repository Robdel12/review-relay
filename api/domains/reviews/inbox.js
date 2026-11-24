import { uuid } from '../../../protocol.js';
import { chatMessage } from './feedback.js';
import { InputError } from './input-error.js';
import { deliveryTransition } from './reviews.machine.js';
import { endWatch } from './watches.js';

const kinds = new Set(['review', 'comment', 'changes', 'requested', 'merged', 'closed']);

function incoming(event, ready) {
  if (
    !event ||
    !uuid.test(event.link) ||
    typeof event.id !== 'string' ||
    !event.id.startsWith(`${event.link}:`) ||
    !uuid.test(event.id.slice(37)) ||
    !kinds.has(event.kind) ||
    !Number.isSafeInteger(event.received)
  ) {
    return null;
  }
  return {
    id: event.id,
    link: event.link,
    kind: event.kind,
    ref: Number.isSafeInteger(event.ref) && event.ref > 0 ? event.ref : null,
    head: /^[a-f0-9]{40}$/i.test(event.head) ? event.head : null,
    received: event.received,
    ready,
    status: 'pending',
    attempts: 0,
    sent_at: null,
  };
}

export function createInbox({ store, batchMs, changed, scheduleDelivery, notify }) {
  async function receive(batch, { fromRelay = false } = {}) {
    const { ids, alerts } = await store.transaction(async (rows) => {
      if (fromRelay && (await rows.setting('delivery-mode')) !== 'push') {
        return {
          ids: batch.map((event) => event?.id).filter((id) => typeof id === 'string'),
          alerts: [],
        };
      }
      const ids = [];
      const unread = new Set();
      for (const raw of batch) {
        const event = incoming(raw, Date.now() + batchMs);
        if (!event) continue;
        ids.push(event.id);
        const link = await rows.watch(event.link);
        if (link?.status !== 'open') continue;
        const terminal = event.kind === 'merged' || event.kind === 'closed';
        if (['review', 'comment', 'changes'].includes(event.kind) && !event.ref) continue;
        const status = terminal
          ? (await deliveryTransition(event, { type: 'archived' })).status
          : event.status;
        const firstUnread =
          !terminal && link.provider === 'claude' && !(await rows.pendingDelivery(link.id));
        if (!(await rows.addDelivery({ ...event, status }))) continue;
        if (firstUnread) unread.add(link.id);
        if (terminal) await endWatch(rows, link.id, event.kind, event.received);
        else await rows.postponeNewDeliveries(event.ready, link.id);
      }
      const alerts = [];
      for (const id of unread) {
        if ((await rows.watch(id)).status === 'open') alerts.push(id);
      }
      return { ids, alerts };
    });
    for (const id of alerts) notify(id, 'claude-feedback');
    return ids;
  }

  async function takeClaudeFeedback({ session }) {
    const messages = await store.transaction(async (rows) => {
      const entries = await rows.claudeDeliveries(session.toLowerCase());
      const messages = [];
      let length = 0;
      for (const [id, events] of Map.groupBy(entries, (entry) => entry.link)) {
        const message = chatMessage(await rows.watch(id), events);
        length += message.length + 2;
        if (length > 8000) break;
        messages.push(message);
        const at = Date.now();
        for (const event of events) {
          await rows.setDelivery(
            event.id,
            await deliveryTransition(event, { type: 'delivered', at }),
          );
        }
      }
      return messages;
    });
    if (messages.length) changed();
    return { messages };
  }

  async function retryDelivery(id, input) {
    const link = await store.transaction(async (rows) => {
      const event = await rows.delivery(id);
      if (!event) throw new InputError('Delivery not found.', 404);
      const link = await rows.watch(event.link);
      if (link.status !== 'open') throw new InputError('This watch has ended.', 409);
      if (
        input?.status !== undefined &&
        (input.status !== event.status || input.sentAt !== event.sent_at)
      ) {
        throw new InputError('This delivery changed. Check its latest status.', 409);
      }
      const next = await deliveryTransition(event, { type: 'retry', at: Date.now() });
      if (next.status === event.status) {
        throw new InputError('This delivery changed. Check its latest status.', 409);
      }
      await rows.setDelivery(id, next);
      return link;
    });
    if (link.provider === 'claude') notify(link.id, 'claude-requeued');
    await scheduleDelivery();
    changed();
  }

  function nextBatch(at) {
    return store.transaction(async (rows) => {
      const id = await rows.nextCodexLink(at);
      return id
        ? { watch: await rows.watch(id), events: await rows.readyDeliveries(id, at) }
        : null;
    });
  }

  function recordAttempt(id, batch, outcome) {
    return store.transaction(async (rows) => {
      const closed = (await rows.watch(id))?.status !== 'open';
      const event = outcome.type === 'rejected' ? { ...outcome, watchOpen: !closed } : outcome;
      for (const { id } of batch) {
        const row = await rows.delivery(id);
        await rows.setDelivery(id, await deliveryTransition(row, event));
      }
    });
  }

  return { receive, takeClaudeFeedback, retryDelivery, nextBatch, recordAttempt };
}
