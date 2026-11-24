import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deliveryTransition,
  initialWatch,
  watchTransition,
} from '../api/domains/reviews/reviews.machine.js';

const entry = (status, overrides) =>
  Object.freeze({ status, attempts: 0, ready: 0, sent_at: null, ...overrides });

test('closed, merged, and stopped watches stay in history', async () => {
  for (const end of ['closed', 'merged', 'stopped']) {
    const open = await initialWatch('open', 1000);
    assert.deepEqual(open, { status: 'open', ended: null });
    const archived = await watchTransition(open, { type: end, at: 2000 });
    assert.deepEqual(archived, { status: end, ended: 2000 });
    assert.deepEqual(await initialWatch(end, 2000), archived);
    for (const later of ['closed', 'merged', 'stopped']) {
      assert.deepEqual(await watchTransition(archived, { type: later, at: 3000 }), archived);
    }
  }
});

test('accepted follow-ups can be requeued and history entries stay archived', async () => {
  const pending = entry('pending', { attempts: 1, sent_at: 1000 });
  assert.deepEqual(await deliveryTransition(pending, { type: 'accepted', at: 1000 }), {
    status: 'queued',
    ready: 1000,
    attempts: 2,
    sentAt: 1001,
  });

  const retry = { type: 'retry', at: 2000 };
  const archived = await deliveryTransition(entry('pending'), { type: 'archived' });
  assert.equal(archived.status, 'archived');
  for (const status of ['queued', 'delivered']) {
    assert.deepEqual(
      await deliveryTransition(entry(status, { attempts: 2, sent_at: 1000 }), retry),
      {
        status: 'pending',
        ready: 2000,
        attempts: 0,
        sentAt: 1000,
      },
    );
  }
  for (const status of [archived.status, 'skipped', 'pending']) {
    assert.equal((await deliveryTransition(entry(status), retry)).status, status);
  }
});

test('retryable delivery failures back off, permanent ones need a manual retry', async () => {
  const rejected = Object.freeze({ type: 'rejected', watchOpen: true, timedOut: false, at: 1000 });
  assert.deepEqual(await deliveryTransition(entry('pending'), rejected), {
    status: 'pending',
    ready: 21_000,
    attempts: 1,
    sentAt: null,
  });
  assert.equal(
    (await deliveryTransition(entry('pending', { attempts: 4 }), rejected)).status,
    'failed',
  );
  assert.equal(
    (await deliveryTransition(entry('pending'), { ...rejected, timedOut: true })).status,
    'failed',
  );
  assert.equal(
    (await deliveryTransition(entry('failed'), { type: 'retry', at: 2000 })).status,
    'pending',
  );
});

test('stopping a watch skips work that has not been sent', async () => {
  for (const status of ['pending', 'failed']) {
    assert.equal(
      (await deliveryTransition(entry(status), { type: 'cancelled' })).status,
      'skipped',
    );
  }
  const rejected = { type: 'rejected', watchOpen: false, timedOut: false, at: 1000 };
  assert.equal((await deliveryTransition(entry('pending'), rejected)).status, 'skipped');
  assert.equal((await deliveryTransition(entry('skipped'), rejected)).status, 'skipped');
  assert.equal((await deliveryTransition(entry('queued'), { type: 'cancelled' })).status, 'queued');
  assert.equal(
    (await deliveryTransition(entry('skipped'), { type: 'accepted', at: 1000 })).status,
    'queued',
  );
});
