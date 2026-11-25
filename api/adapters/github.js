import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { githubRepoFromRemote, loginName } from '../../protocol.js';
import { prURL } from '../domains/reviews/feedback.js';
import { InputError } from '../domains/reviews/input-error.js';
import { pollLink } from './poll.js';

const run = promisify(execFile);

const git = async (cwd, ...args) =>
  (await run('/usr/bin/git', args, { cwd, timeout: 5000 })).stdout.trim();

async function readCheckout(path) {
  const cwd = realpathSync(path);
  const [root, remote] = await Promise.all([
    git(cwd, 'rev-parse', '--show-toplevel'),
    git(cwd, 'remote', 'get-url', 'origin'),
  ]);
  const repo = githubRepoFromRemote(remote);
  if (realpathSync(root) !== cwd || !repo) throw new Error('Invalid checkout');
  return { cwd, repo: repo.toLowerCase() };
}

async function checkout(path) {
  try {
    if (!isAbsolute(path)) throw new Error('Expected absolute path');
    return await readCheckout(path);
  } catch {
    throw new InputError('Enter the absolute path to a GitHub checkout with an origin remote.');
  }
}

async function gitWorktree(path, repo, branch) {
  try {
    const primary = await readCheckout(path);
    if (primary.repo !== repo) throw new Error();
    if (!branch || (await git(primary.cwd, 'branch', '--show-current')) === branch) {
      return primary.cwd;
    }
    const ref = `refs/heads/${branch}`;
    const worktrees = await git(primary.cwd, 'worktree', 'list', '--porcelain', '-z');
    const matching = worktrees
      .split('\0\0')
      .map((record) => record.split('\0'))
      .filter(
        (fields) =>
          fields[0].startsWith('worktree ') &&
          fields.includes(`branch ${ref}`) &&
          !fields.some((field) => field.startsWith('prunable')),
      );
    if (matching.length === 1) {
      const linkedCheckout = await readCheckout(matching[0][0].slice('worktree '.length));
      if (linkedCheckout.repo !== repo) throw new Error();
      if ((await git(linkedCheckout.cwd, 'branch', '--show-current')) !== branch) {
        throw new Error();
      }
      return linkedCheckout.cwd;
    }
    await git(primary.cwd, 'show-ref', '--verify', '--quiet', ref);
    return null;
  } catch {
    throw new InputError('Choose the root of the matching PR checkout.');
  }
}

export function createGitHub(gh) {
  async function api(endpoint, paginate = false) {
    const args = ['api', '--hostname', 'github.com', endpoint];
    if (paginate) args.push('--paginate', '--slurp');
    const { stdout } = await run(gh, args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    return paginate ? result.flat() : result;
  }

  async function outstandingReviews({ repo, login, since }) {
    if (!loginName.test(login)) throw new Error('Invalid GitHub login');
    const day = new Date(since).toISOString().slice(0, 10);
    const query = encodeURIComponent(
      `repo:${repo} is:pr is:open review-requested:${login} updated:>=${day}`,
    );
    const pages = await api(`search/issues?q=${query}&per_page=100`, true);
    if (pages.some((page) => page.incomplete_results || page.total_count > 1000)) {
      throw new Error('Incomplete GitHub search');
    }
    return [...new Set(pages.flatMap((page) => page.items.map((item) => item.number)))].filter(
      (number) => Number.isSafeInteger(number) && number > 0,
    );
  }

  async function freshRequest({ repo, login, since }, number) {
    const timeline = await api(`repos/${repo}/issues/${number}/timeline?per_page=100`, true);
    const requested = timeline.findLast(
      (event) =>
        event.event === 'review_requested' &&
        event.requested_reviewer?.login?.toLowerCase() === login,
    );
    const requestedSinceEnabled = Date.parse(requested?.created_at) >= since;
    if (!requestedSinceEnabled) return null;

    const alreadyReviewed = timeline.some(
      (event) =>
        event.event === 'reviewed' &&
        event.submitted_at &&
        event.user?.login?.toLowerCase() === login,
    );
    if (alreadyReviewed) return null;

    const pr = await api(`repos/${repo}/pulls/${number}`);
    if (
      pr.number !== number ||
      pr.state !== 'open' ||
      pr.draft ||
      pr.user?.login?.toLowerCase() === login ||
      !pr.requested_reviewers?.some((person) => person.login?.toLowerCase() === login)
    )
      return null;
    return pr;
  }

  return Object.freeze({
    async metadata(fields) {
      const [pr, me] = await Promise.all([
        run(
          gh,
          ['pr', 'view', prURL(fields), '--json', 'author,title,state,createdAt,headRefName'],
          {
            timeout: 15_000,
          },
        ),
        run(gh, ['api', 'user', '--hostname', 'github.com', '--jq', '.login'], { timeout: 15_000 }),
      ]);
      return { pr: JSON.parse(pr.stdout), login: me.stdout.trim().toLowerCase() };
    },
    async login() {
      return (await api('user')).login.toLowerCase();
    },
    poll: (link, previous) => pollLink(link, api, previous),
    gitWorktree,
    checkout,
    outstandingReviews,
    freshRequest,
  });
}
