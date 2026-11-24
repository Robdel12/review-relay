import { randomUUID } from 'node:crypto';
import { normalizeLink, parseChat, parsePR } from '../../../protocol.js';
import { InputError } from './input-error.js';
import { deliveryTransition, initialWatch, watchTransition } from './reviews.machine.js';

export async function endWatch(rows, id, type, at) {
  const current = rows.watch(id);
  if (!current) return;
  const next = await watchTransition(current, { type, at });
  if (next.status === current.status) return;
  rows.endWatch(next.status, next.ended, id);
  for (const event of rows.cancelableDeliveries(id)) {
    rows.setDelivery(event.id, await deliveryTransition(event, { type: 'cancelled' }));
  }
}

export function createWatches({ store, github, watchChanged }) {
  async function linkPR(input) {
    const fields = parsePR(input?.pr);
    const chat = parseChat(input?.chat);
    if (!fields || !chat)
      throw new InputError(
        'Enter a GitHub PR URL and a Codex chat link or Claude Code session reference.',
      );
    const { thread, provider } = chat;
    const sameChat = (link) => link.provider === provider && link.thread.toLowerCase() === thread;
    const current = await store.read((rows) => rows.openWatch(fields.repo, fields.number));
    if (current && !sameChat(current)) {
      throw new InputError(
        'That PR already has an active chat. Stop the link first to change it.',
        409,
      );
    }
    if (current?.title && !input.worktree) {
      if (input.expect && input.expect !== current.role)
        throw new InputError('That PR is linked in the other review role.', 409);
      return current;
    }
    let meta, login;
    try {
      ({ pr: meta, login } = await github.metadata(fields));
    } catch {
      throw new InputError(
        'Could not read the PR. Check your GitHub CLI login and repository access.',
        502,
      );
    }
    const role = meta.author?.login?.toLowerCase() === login ? 'author' : 'reviewer';
    if (input.expect && input.expect !== role)
      throw new InputError(`GitHub identifies you as the ${role} for this PR.`, 409);
    const status = ['OPEN', 'CLOSED', 'MERGED'].includes(meta.state)
      ? meta.state.toLowerCase()
      : null;
    if (!status || !normalizeLink({ id: randomUUID(), ...fields, login, role }))
      throw new InputError('Invalid GitHub response.', 502);
    const created = Date.parse(meta.createdAt);
    if (
      input.auto === 'opened' &&
      (role !== 'author' ||
        status !== 'open' ||
        !Number.isFinite(created) ||
        Math.abs(Date.now() - created) > 15 * 60_000 ||
        typeof meta.headRefName !== 'string' ||
        !meta.headRefName ||
        !input.worktree)
    ) {
      throw new InputError('This command did not open a matching PR recently.', 409);
    }
    const worktree =
      input.worktree && role === 'author'
        ? await github.gitWorktree(
            input.worktree,
            fields.repo,
            input.auto === 'opened' ? meta.headRefName : null,
          )
        : (current?.worktree ?? null);
    const linked = await store.write(async (rows) => {
      const current = rows.openWatch(fields.repo, fields.number);
      if (current && !sameChat(current)) {
        throw new InputError('That PR already has an active chat.', 409);
      }
      if (status === 'open' && !current && rows.openWatches().length >= 100) {
        throw new InputError('The workspace supports up to 100 active links.');
      }
      if (current) {
        if (status !== 'open') await endWatch(rows, current.id, status, Date.now());
        rows.updateWatch(meta.title, worktree, current.id);
        return rows.watch(current.id);
      }

      const existing = rows.matchingWatch(fields.repo, fields.number, thread, provider, status);
      if (existing) return existing;
      const id = randomUUID();
      const created = Date.now();
      rows.addWatch({
        ...fields,
        id,
        login,
        role,
        thread,
        title: meta.title,
        worktree,
        ...(await initialWatch(status, created)),
        created,
        provider,
      });
      return rows.watch(id);
    });
    await watchChanged(0);
    return linked;
  }

  async function unlinkPR(id) {
    await store.write((rows) => endWatch(rows, id, 'stopped', Date.now()));
    await watchChanged();
  }

  return { linkPR, unlinkPR };
}
