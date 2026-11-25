import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify, stripVTControlCharacters } from 'node:util';
import { chatReference, uuid } from '../../protocol.js';
import { startCodexReview } from './codex-session.js';

const run = promisify(execFile);

export const reviewModels = Object.freeze({
  codex: 'gpt-6.2-sol',
  claude: 'claude-opus-5-5',
});

export function createAgents({
  codex,
  codexSocket,
  codexSkill,
  claude,
  claudeSkill,
  notifier,
  origin,
}) {
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

  async function startReview({ provider, cwd, title, prompt }) {
    const model = reviewModels[provider];
    if (provider === 'codex') {
      const skill = existsSync(codexSkill)
        ? { type: 'skill', name: 'pull-request-review', path: codexSkill }
        : null;
      return startCodexReview({
        socketPath: codexSocket,
        cwd,
        title,
        text: skill ? `$pull-request-review ${prompt}` : prompt,
        skill,
        model,
      });
    }

    const skill = [claudeSkill, codexSkill].find((path) => existsSync(path));
    const context = skill ? `Read and follow the pull-request-review skill at ${skill}. ` : '';
    const { stdout, stderr } = await run(
      claude,
      ['--bg', '--name', title, '--model', model, '--', `${context}${prompt}`],
      { cwd, timeout: 20_000 },
    );
    const output = stripVTControlCharacters(`${stdout}\n${stderr}`);
    const attachId = /^ *claude attach ([a-f0-9]{8})\b/m.exec(output)?.[1];
    if (!attachId) throw new Error('Claude Code did not return an attach command');
    const sessions = await run(claude, ['agents', '--json', '--all'], { cwd, timeout: 10_000 });
    const session = JSON.parse(sessions.stdout).find(
      (item) => item.id === attachId && item.kind === 'background' && item.cwd === cwd,
    );
    if (!uuid.test(session?.sessionId)) throw new Error('Invalid Claude Code session ID');
    return { thread: session.sessionId, attachId };
  }

  return Object.freeze({ queueCodex, notify, startReview });
}
