import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { prURL } from '../domains/reviews/feedback.js';
import { InputError } from '../domains/reviews/input-error.js';
import { pollLink } from './poll.js';

const run = promisify(execFile);

async function gitWorktree(path, repo, branch) {
  try {
    const directory = realpathSync(path);
    const invoke = async (cwd, ...args) =>
      (await run('/usr/bin/git', args, { cwd, timeout: 5000 })).stdout.trim();
    async function verifyRoot(root) {
      const [top, remote] = await Promise.all([
        invoke(root, 'rev-parse', '--show-toplevel'),
        invoke(root, 'remote', 'get-url', 'origin'),
      ]);
      const match =
        /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/i.exec(
          remote.replace(/\.git$/, ''),
        );
      if (realpathSync(top) !== root || match?.[1].toLowerCase() !== repo) throw new Error();
    }
    await verifyRoot(directory);
    if (!branch || (await invoke(directory, 'branch', '--show-current')) === branch)
      return directory;
    const ref = `refs/heads/${branch}`;
    const worktrees = await invoke(directory, 'worktree', 'list', '--porcelain', '-z');
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
      const root = realpathSync(matching[0][0].slice('worktree '.length));
      await verifyRoot(root);
      if ((await invoke(root, 'branch', '--show-current')) !== branch) throw new Error();
      return root;
    }
    await invoke(directory, 'show-ref', '--verify', '--quiet', ref);
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
  });
}
