import { EventEmitter, once } from 'node:events';
import { startCricketWorker } from '@robdel12/cricket/jobs';
import { dispatchFeedback, notifyAgent, pollReviews } from '../domains/reviews/reviews.jobs.js';

function createWakeQueue() {
  const wake = new EventEmitter();
  const pending = new Map();
  const active = new Map();
  const key = (envelope) => (envelope.name === notifyAgent.name ? envelope.id : envelope.name);

  function next() {
    return [...pending.values()]
      .filter((envelope) => !active.has(key(envelope)))
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt))[0];
  }

  function finish(envelope, _result, { attempt }) {
    const claimed = active.get(key(envelope));
    if (claimed?.id !== envelope.id || attempt !== 1) return { settled: false };
    active.delete(key(envelope));
    wake.emit('change');
    return { settled: true };
  }

  return {
    enqueue(envelope) {
      pending.set(key(envelope), envelope);
      wake.emit('change');
      return { enqueued: true, envelope };
    },
    cancel(name) {
      if (pending.delete(name)) wake.emit('change');
    },
    claim() {
      const envelope = next();
      if (!envelope || Date.parse(envelope.availableAt) > Date.now()) return undefined;
      pending.delete(key(envelope));
      active.set(key(envelope), envelope);
      return { envelope, attempt: 1 };
    },
    async waitForWork({ signal, waitUntil }) {
      if (signal.aborted) return;
      const wait = new AbortController();
      const combined = AbortSignal.any([signal, wait.signal]);
      const changed = once(wake, 'change', { signal: combined });
      const deadline = next()?.availableAt;
      try {
        await Promise.race([
          changed,
          ...(deadline ? [waitUntil(deadline, { signal: combined })] : []),
        ]);
      } catch (error) {
        if (!combined.aborted || error.name !== 'AbortError') throw error;
      } finally {
        wait.abort();
      }
    },
    complete: finish,
    fail: finish,
  };
}

export async function startReviewWorker(app) {
  // Only wakeups live here. Each run rereads SQLite, which is also how startup recovers.
  const driver = createWakeQueue();
  const worker = await startCricketWorker(app, { queues: { driver } });

  let stopping = false;
  function enqueue(job, input, options) {
    if (stopping) return;
    worker.jobs.enqueue(job, input, options).catch((error) => {
      worker.runtime.logger.error('review-relay.schedule.failed', {
        job: job.name,
        error: error.name,
      });
    });
  }

  function schedule(job, at) {
    if (at === null) driver.cancel(job.name);
    else enqueue(job, {}, { runAt: new Date(at) });
  }

  return Object.freeze({
    pollAt: (at) => schedule(pollReviews, at),
    deliverAt: (at) => schedule(dispatchFeedback, at),
    notify: (id, reason) => enqueue(notifyAgent, { id, reason }),
    run: () => worker.run({ concurrency: 4 }),
    async cleanup() {
      stopping = true;
      await worker.cleanup();
    },
  });
}
