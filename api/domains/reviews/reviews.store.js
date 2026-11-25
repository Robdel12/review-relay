import { randomUUID } from 'node:crypto';
import { defaultReviewSkill, normalizeLink, uuid } from '../../../protocol.js';

const reviewSkillKey = 'review-skill';

function queries(db) {
  const settings = () => db('settings');
  const watches = () => db('links');
  const reviewStarts = () => db('review_starts');
  const deliveries = () => db('events');
  const openWatches = () => watches().where({ status: 'open' }).orderBy('created', 'desc');
  const codexPending = () =>
    deliveries()
      .join('links', 'links.id', 'events.link')
      .where({ 'events.status': 'pending', 'links.provider': 'codex' });

  const setting = async (key) => (await settings().where({ key }).first('value'))?.value;

  const set = (key, value) => settings().insert({ key, value }).onConflict('key').merge();

  return {
    setting,
    set,
    reviewSkill: async () => (await setting(reviewSkillKey)) ?? defaultReviewSkill,
    setReviewSkill: (name) => set(reviewSkillKey, name),
    async trackedReview(fields) {
      return Boolean(
        (await watches().where(fields).first('id')) ||
          (await reviewStarts().where(fields).first('number')),
      );
    },
    addReviewStart: (start) => reviewStarts().insert(start),
    setReviewStart: (fields, status) => reviewStarts().where(fields).update({ status }),
    unresolvedReviewStart: async (repo) =>
      (await reviewStarts()
        .where({ repo })
        .whereIn('status', ['failed', 'starting'])
        .whereNotExists(
          watches()
            .whereColumn('links.repo', 'review_starts.repo')
            .whereColumn('links.number', 'review_starts.number'),
        )
        .orderBy('created', 'desc')
        .first('number', 'status')) ?? null,
    setAttachId: (id, attach_id) => watches().where({ id }).update({ attach_id }),
    addWatch: (watch) => watches().insert(watch).onConflict().ignore(),
    watch: (id) => watches().where({ id }).first(),
    openWatch: (repo, number) => openWatches().where({ repo, number }).first(),
    openWatches,
    matchingWatch: (repo, number, thread, provider, status) =>
      watches().where({ repo, number, thread, provider, status }).first(),
    updateWatch: (title, worktree, id) => watches().where({ id }).update({ title, worktree }),
    endWatch: (status, ended, id) => watches().where({ id }).update({ status, ended }),
    dashboardWatches: () => watches().orderByRaw("(status = 'open') DESC, created DESC").limit(100),
    dashboardDeliveries: () =>
      deliveries()
        .join('links', 'links.id', 'events.link')
        .select(
          'events.id',
          'events.kind',
          'events.status',
          'events.received',
          'events.sent_at as sentAt',
          'links.repo',
          'links.number',
          'links.thread',
          'links.attach_id',
          'links.role',
          'links.provider',
          'links.status as watchStatus',
        )
        .orderBy('events.received', 'desc')
        .limit(35),
    async addDelivery(event) {
      const inserted = await deliveries().insert(event).onConflict('id').ignore().returning('id');
      return inserted.length > 0;
    },
    pendingDelivery: (link) => deliveries().where({ link, status: 'pending' }).first('id'),
    postponeNewDeliveries: (ready, link) =>
      deliveries().where({ link, status: 'pending', attempts: 0 }).update({ ready }),
    delivery: (id) => deliveries().where({ id }).first(),
    setDelivery: (id, { status, attempts, ready, sentAt }) =>
      deliveries().where({ id }).update({ status, attempts, ready, sent_at: sentAt }),
    cancelableDeliveries: (link) =>
      deliveries().where({ link }).whereIn('status', ['pending', 'failed']),
    claudeDeliveries: (thread) =>
      deliveries()
        .join('links', 'links.id', 'events.link')
        .where({
          'links.provider': 'claude',
          'links.thread': thread,
          'links.status': 'open',
          'events.status': 'pending',
        })
        .select('events.*')
        .orderBy('events.received')
        .limit(25),
    async nextCodexDeadline() {
      const { ready } = await codexPending().min('events.ready as ready').first();
      return ready;
    },
    async nextCodexLink(now) {
      const event = await codexPending()
        .where('events.ready', '<=', now)
        .orderBy('events.ready')
        .first('events.link');
      return event?.link;
    },
    readyDeliveries: (link, now) =>
      deliveries()
        .where({ link, status: 'pending' })
        .where('ready', '<=', now)
        .orderBy('received')
        .limit(25),
  };
}

export function createReviewStore(db) {
  return {
    transaction: (action) => db.transaction((trx) => action(queries(trx))),
  };
}

export function importLegacyWatches(store, legacy) {
  return store.transaction(async (rows) => {
    if (await rows.setting('imported')) return;
    for (const entry of Object.values(legacy)) {
      const watch = normalizeLink({ ...entry, id: randomUUID() });
      if (!watch || !uuid.test(entry.thread)) continue;
      await rows.addWatch({
        ...watch,
        thread: entry.thread,
        title: null,
        worktree: entry.worktree ?? null,
        status: entry.status === 'open' ? 'open' : 'closed',
        created: Date.now(),
        ended: null,
        provider: 'codex',
      });
    }
    await rows.set('imported', '1');
  });
}
