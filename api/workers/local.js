import { startCricketWorker } from '@robdel12/cricket/jobs';
import {
  dispatchFeedback,
  notifyAgent,
  pollReviews,
  wakeKey,
} from '../domains/reviews/reviews.jobs.js';

export async function startReviewWorker(app, signal) {
  const worker = await startCricketWorker(app, { queues: { local: true } });

  function onQueueError(job, error) {
    worker.runtime.logger.error('review-relay.schedule.failed', {
      job: job.name,
      error: error.name,
    });
  }

  function enqueue(job, input, options) {
    if (signal.aborted) return;
    worker.jobs.enqueue(job, input, options).catch((error) => onQueueError(job, error));
  }

  function schedule(job, at) {
    if (at === null) {
      worker.jobs.cancelPending(job, wakeKey).catch((error) => onQueueError(job, error));
    } else {
      enqueue(job, {}, { runAt: new Date(at) });
    }
  }

  return Object.freeze({
    pollAt: (at) => schedule(pollReviews, at),
    deliverAt: (at) => schedule(dispatchFeedback, at),
    notify: (id, reason) => enqueue(notifyAgent, { id, reason }),
    run: () => worker.run({ signal, concurrency: 4 }),
    cleanup: worker.cleanup,
  });
}
