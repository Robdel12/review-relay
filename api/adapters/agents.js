import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { chatReference, defaultReviewSkill, skillName, uuid } from '../../protocol.js';
import { skillInstruction } from '../domains/reviews/feedback.js';
import { prepareCodexReview } from './codex-session.js';

const run = promisify(execFile);

export const reviewModels = Object.freeze({
  codex: 'gpt-6.2-sol',
  claude: 'claude-opus-5-5',
});

export function createAgents({
  codex,
  codexHome,
  codexDefaultSkill,
  claude,
  claudeHome,
  notifier,
  opener,
  origin,
}) {
  async function queueCodex(link, message) {
    await run(codex, ['queue', '--thread', link.thread, '--message', message], {
      timeout: 20_000,
      env: { ...process.env, CODEX_HOME: codexHome },
    });
  }

  async function openCodex(link) {
    await run(opener, ['-g', chatReference(link)], { timeout: 5_000 });
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

  function reviewSkill(provider, name) {
    if (!skillName.test(name)) return null;
    const candidates = [];
    if (provider === 'claude') candidates.push(join(claudeHome, 'skills', name, 'SKILL.md'));
    if (name === defaultReviewSkill && codexDefaultSkill) candidates.push(codexDefaultSkill);
    candidates.push(join(codexHome, 'skills', name, 'SKILL.md'));
    const path = candidates.find((candidate) => {
      try {
        return statSync(candidate, { throwIfNoEntry: false })?.isFile();
      } catch {
        return false;
      }
    });
    return path ? { type: 'skill', name, path } : null;
  }

  async function startClaudeReview({ cwd, title, prompt, skill, model }) {
    const { stdout, stderr } = await run(
      claude,
      ['--bg', '--name', title, '--model', model, '--', `${skillInstruction(skill)}${prompt}`],
      { cwd, timeout: 20_000 },
    );
    const output = stripVTControlCharacters(`${stdout}\n${stderr}`);
    const attachId = /^ *claude attach ([a-f0-9]{8})\b/m.exec(output)?.[1];
    if (!attachId) throw new Error('Claude Code did not return an attach command');
    const { stdout: sessions } = await run(claude, ['agents', '--json', '--all'], {
      cwd,
      timeout: 10_000,
    });
    const session = JSON.parse(sessions).find(
      (item) => item.id === attachId && item.kind === 'background' && item.cwd === cwd,
    );
    if (!uuid.test(session?.sessionId)) throw new Error('Invalid Claude Code session ID');
    return { thread: session.sessionId, attachId };
  }

  async function startReview({ provider, cwd, title, prompt, skillName }) {
    const model = reviewModels[provider];
    const skill = reviewSkill(provider, skillName);
    if (provider !== 'codex') return startClaudeReview({ cwd, title, prompt, skill, model });
    return prepareCodexReview({
      codex,
      codexHome,
      cwd,
      title,
      text: skill ? `$${skill.name} ${prompt}` : prompt,
      skill,
      model,
    });
  }

  return Object.freeze({ queueCodex, openCodex, notify, startReview, reviewSkill });
}
