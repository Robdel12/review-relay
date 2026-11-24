import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryOutcome, deliveryStatus, watchStatus } from '../lifecycle.js';

test('closed, merged, and stopped watches stay in history', () => {
  for (const end of ['closed', 'merged', 'stopped']) {
    assert.equal(watchStatus('open', end), end);
    for (const later of ['closed', 'merged', 'stopped']) {
      assert.equal(watchStatus(end, later), end);
    }
  }
});

test('accepted follow-ups can be requeued and history entries stay archived', () => {
  const pending = Object.freeze({ status: 'pending', attempts: 1 });
  assert.deepEqual(deliveryOutcome(pending, { type: 'accepted' }, 1000), {
    status: 'queued',
    ready: 1000,
    attempts: 2,
  });

  const fromClosedPR = deliveryStatus('pending', { type: 'archived' });
  assert.equal(fromClosedPR, 'archived');
  for (const status of ['queued', 'delivered']) {
    assert.equal(deliveryStatus(status, { type: 'retry' }), 'pending');
  }
  for (const status of [fromClosedPR, 'skipped', 'pending']) {
    assert.equal(deliveryStatus(status, { type: 'retry' }), status);
  }
});

test('retryable delivery failures back off, permanent ones need a manual retry', () => {
  const rejected = Object.freeze({ type: 'rejected', watchOpen: true, timedOut: false });
  assert.deepEqual(deliveryOutcome({ status: 'pending', attempts: 0 }, rejected, 1000), {
    status: 'pending',
    ready: 21_000,
    attempts: 1,
  });
  assert.equal(
    deliveryOutcome({ status: 'pending', attempts: 4 }, rejected, 1000).status,
    'failed',
  );
  assert.equal(
    deliveryOutcome({ status: 'pending', attempts: 0 }, { ...rejected, timedOut: true }, 1000)
      .status,
    'failed',
  );
  assert.equal(deliveryStatus('failed', { type: 'retry' }), 'pending');
});

test('stopping a watch skips work that has not been sent', () => {
  for (const status of ['pending', 'failed']) {
    assert.equal(deliveryStatus(status, { type: 'cancelled' }), 'skipped');
  }
  const stopped = { type: 'rejected', watchOpen: false, timedOut: false };
  assert.equal(
    deliveryOutcome({ status: 'pending', attempts: 0 }, stopped, 1000).status,
    'skipped',
  );
  assert.equal(deliveryStatus('queued', { type: 'cancelled' }), 'queued');
});
