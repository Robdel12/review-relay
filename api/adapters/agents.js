import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { chatReference } from '../../protocol.js';

const run = promisify(execFile);

export function createAgents({ codex, notifier, origin }) {
  async function queueCodex(link, message) {
    await run(
      codex,
      ['queue', '--remote', 'unix://', '--thread', link.thread, '--message', message],
      { timeout: 20_000 },
    );
  }

  async function notify(link, message) {
    if (!existsSync(notifier)) return;
    await run(
      notifier,
      [
        '-title',
        'Review Relay',
        '-subtitle',
        `#${link.number}`,
        '-message',
        message,
        '-open',
        link.provider === 'claude' ? origin() : chatReference(link),
      ],
      { timeout: 5_000 },
    ).catch(() => {});
  }

  return Object.freeze({ queueCodex, notify });
}
