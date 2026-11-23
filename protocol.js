export const protocol = 'pr-chat.v1';
export const maxWebhook = 2 * 1024 * 1024;
export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const repoName = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
export const loginName = /^[a-z0-9-]{1,39}$/i;

export function parsePR(value) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { repo: match[1].toLowerCase(), number: Number(match[2]) };
}

export function normalizeLink(link) {
  if (!link || !uuid.test(link.id) || !repoName.test(link.repo) ||
      !Number.isSafeInteger(link.number) || link.number < 1 ||
      !loginName.test(link.login) || !['author', 'reviewer'].includes(link.role)) return null;
  return { id: link.id.toLowerCase(), repo: link.repo.toLowerCase(), number: link.number,
    login: link.login.toLowerCase(), role: link.role };
}

export function normalizeEvent(type, payload, link) {
  const pr = payload?.pull_request;
  if (payload?.repository?.full_name?.toLowerCase() !== link.repo || pr?.number !== link.number) return null;
  const { action } = payload;
  if (type === 'pull_request' && action === 'closed') {
    return { kind: pr.merged === true ? 'merged' : 'closed' };
  }
  if (pr.state !== 'open' || pr.draft) return null;
  const head = /^[a-f0-9]{40}$/i.test(pr.head?.sha) ? pr.head.sha : null;
  if (link.role === 'reviewer') {
    return type === 'pull_request' && action === 'review_requested' &&
      payload.requested_reviewer?.login?.toLowerCase() === link.login
      ? { kind: 'requested', head } : null;
  }

  const author = type === 'pull_request_review' ? payload.review?.user : payload.comment?.user;
  if (!author?.login || author.type === 'Bot' || author.login.toLowerCase() === link.login) return null;
  const state = payload.review?.state;
  if (type === 'pull_request_review' && action === 'submitted' && Number.isSafeInteger(payload.review?.id) &&
      (state === 'changes_requested' || (['commented', 'approved'].includes(state) &&
        typeof payload.review.body === 'string' && payload.review.body.trim()))) {
    return { kind: state === 'changes_requested' ? 'changes' : 'review', ref: payload.review.id, head };
  }
  if (type === 'pull_request_review_comment' && action === 'created' && Number.isSafeInteger(payload.comment?.id)) {
    return { kind: 'comment', ref: payload.comment.id, head };
  }
  return null;
}

export async function readBytes(body, maximum) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  let length = 0;
  const pieces = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new RangeError('Request too large');
    }
    pieces.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  return bytes;
}

export async function verifyWebhook(raw, signature, secret) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature ?? '')) return false;
  const expected = Uint8Array.from(signature.slice(7).match(/../g), part => Number.parseInt(part, 16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, expected, raw);
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
