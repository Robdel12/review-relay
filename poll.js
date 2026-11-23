import { createHash } from 'node:crypto';
import { normalizeEvent } from './protocol.js';

function deliveryId(linkId, key) {
  const hash = createHash('sha256').update(`${linkId}:${key}`).digest('hex');
  const suffix = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
  return `${linkId}:${suffix}`;
}

export async function pollLink(link, api, previous = new Set()) {
  const endpoint = `repos/${link.repo}/pulls/${link.number}`;
  const pull = await api(endpoint);
  const envelope = { repository: { full_name: link.repo }, pull_request: pull };
  const result = [];
  function collect(type, action, key, time, fields) {
    const received = Date.parse(time);
    if (!Number.isFinite(received) || received < link.created || previous.has(key)) return;
    const event = normalizeEvent(type, { ...envelope, action, ...fields }, link);
    if (event) result.push({ ...event, id: deliveryId(link.id, key), link: link.id, received });
  }

  if (pull.state === 'closed') {
    const kind = pull.merged ? 'merged' : 'closed';
    return [
      {
        kind,
        id: deliveryId(link.id, kind),
        link: link.id,
        received: Date.parse(pull.closed_at) || Date.now(),
      },
    ];
  }
  if (pull.draft) return result;

  const timeline = await api(
    `repos/${link.repo}/issues/${link.number}/timeline?per_page=100`,
    true,
  );
  if (link.role === 'reviewer') {
    const request = timeline.findLast(
      (event) =>
        event.event === 'review_requested' &&
        event.requested_reviewer?.login?.toLowerCase() === link.login,
    );
    if (!request) return result;
    const key = `request/${request.id}`;
    if (previous.has(key) || Date.parse(request.created_at) < link.created) return result;

    const current = await api(endpoint);
    if (
      current.state === 'open' &&
      !current.draft &&
      current.requested_reviewers?.some((person) => person.login.toLowerCase() === link.login)
    ) {
      collect('pull_request', 'review_requested', key, request.created_at, {
        pull_request: current,
        requested_reviewer: request.requested_reviewer,
      });
    }
    return result;
  }
  for (const event of timeline) {
    if (event.event === 'reviewed' && typeof event.state === 'string') {
      collect('pull_request_review', 'submitted', `review/${event.id}`, event.submitted_at, {
        review: { ...event, state: event.state.toLowerCase() },
      });
    }
  }
  const since = encodeURIComponent(new Date(link.created).toISOString());
  const comments = await api(`${endpoint}/comments?per_page=100&since=${since}`, true);
  for (const comment of comments) {
    collect('pull_request_review_comment', 'created', `comment/${comment.id}`, comment.created_at, {
      comment,
    });
  }
  return result;
}
