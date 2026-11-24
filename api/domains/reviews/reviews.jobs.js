import { z } from '@robdel12/cricket';
import { defineJob, state } from '@robdel12/cricket/jobs';
import { uuid } from '../../../protocol.js';
import { chatMessage } from './feedback.js';

const queue = Object.freeze({ name: 'review-relay' });
const empty = z.strictObject({});

export const pollReviews = defineJob({
  name: 'reviews.poll',
  input: empty,
  queue,
  state: state.derived({ from: ['links', 'settings'] }),
  async run({ services: { reviews }, logger }) {
    const links = await reviews.beginPoll();
    if (!links.length) return;
    let error = false;
    try {
      const login = await reviews.github.login();
      for (const link of links) {
        try {
          if (login !== link.login) throw new Error('GitHub login changed');
          const old = reviews.legacy[`${link.repo}#${link.number}`];
          const sameWatch =
            old?.thread === link.thread && old.login === link.login && old.role === link.role;
          const events = await reviews.github.poll(link, new Set(sameWatch ? old.seen : []));
          await reviews.ingest(events);
        } catch {
          error = true;
          logger.warn('github.watch.check_failed', { number: link.number });
        }
      }
    } catch {
      error = true;
      logger.warn('github.login.check_failed');
    } finally {
      await reviews.finishPoll(error);
    }
  },
});

export const dispatchFeedback = defineJob({
  name: 'reviews.deliver',
  input: empty,
  queue,
  state: state.derived({ from: ['events', 'links'] }),
  async run({ services: { reviews }, logger, jobs }) {
    try {
      for (;;) {
        const at = Date.now();
        const batch = await reviews.nextBatch(at);
        if (!batch) break;
        const { watch, events } = batch;
        if (watch.status !== 'open') {
          await reviews.recordAttempt(watch.id, events, { type: 'cancelled' });
          continue;
        }
        let outcome;
        try {
          await reviews.agents.queueCodex(watch, chatMessage(watch, events));
          outcome = { type: 'accepted', at: Date.now() };
        } catch (error) {
          logger.warn('codex.queue.failed', {
            number: watch.number,
            code: error.code ?? error.name,
          });
          outcome = { type: 'rejected', at, timedOut: Boolean(error.killed) };
        }
        await reviews.recordAttempt(watch.id, events, outcome);
        if (outcome.type === 'accepted') {
          await jobs.enqueue(notifyAgent, {
            id: watch.id,
            reason: watch.role === 'reviewer' ? 'codex-requested' : 'codex-feedback',
          });
        }
        reviews.changed();
      }
    } finally {
      await reviews.scheduleDelivery();
    }
  },
});

const notifications = Object.freeze({
  'claude-feedback': 'New GitHub feedback. Resume the linked Claude Code session.',
  'claude-requeued': 'GitHub feedback was requeued. Resume the linked Claude Code session.',
  'codex-requested': 'Your review was requested. Open the linked chat.',
  'codex-feedback': 'New feedback was queued. Open the linked chat.',
});

export const notifyAgent = defineJob({
  name: 'reviews.notify',
  input: z.strictObject({ id: z.string().regex(uuid), reason: z.enum(Object.keys(notifications)) }),
  queue,
  state: state.derived({ from: ['links'] }),
  async run({ services: { reviews }, input }) {
    const link = await reviews.watchForNotice(input.id);
    if (link?.status === 'open') await reviews.agents.notify(link, notifications[input.reason]);
  },
});
