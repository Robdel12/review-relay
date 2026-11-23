import { randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const skill = new URL('./skills/pr-chat/SKILL.md', import.meta.url);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function readSettings(path) {
  try {
    const file = realpathSync(path);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (
      data === null ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      ('hooks' in data &&
        (data.hooks === null || typeof data.hooks !== 'object' || Array.isArray(data.hooks)))
    ) {
      throw new Error('Invalid settings');
    }
    return { file, data };
  } catch (error) {
    if (error.code === 'ENOENT' && !lstatSync(path, { throwIfNoEntry: false }))
      return { file: path, data: {} };
    throw new Error(`Could not read ${path}. Fix the JSON settings and rerun init.`, {
      cause: error,
    });
  }
}

function plan(agent, port) {
  const codex = agent === 'codex';
  const directory = codex
    ? process.env.CODEX_HOME || join(homedir(), '.codex')
    : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const { file, data } = readSettings(join(directory, codex ? 'hooks.json' : 'settings.json'));
  const hookArgs = codex ? 'hook' : 'hook claude';
  const prefix = 'PR_CHAT_INIT=1 ';
  const portAssignment = port ? `PR_CHAT_PORT=${shellQuote(port)} ` : '';
  const command = `${prefix}${portAssignment}${shellQuote(process.execPath)} ${shellQuote(cli)} ${hookArgs}`;
  const events = [
    { name: 'UserPromptSubmit', async: codex },
    { name: 'PostToolUse', matcher: '^Bash$', async: true },
    ...(!codex ? [{ name: 'SessionStart', matcher: 'startup|resume', async: false }] : []),
  ];
  let changed = false;
  data.hooks ??= {};
  for (const event of events) {
    data.hooks[event.name] ??= [];
    const groups = data.hooks[event.name];
    if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks))) {
      throw new Error(
        `Could not merge ${event.name} in ${file}. Check the hook settings and rerun init.`,
      );
    }
    const existing = groups
      .flatMap((group) => group.hooks)
      .find((hook) => {
        const previous = hook?.command;
        return (
          hook?.type === 'command' &&
          typeof previous === 'string' &&
          ((previous.startsWith(prefix) && previous.endsWith(` ${hookArgs}`)) ||
            (codex && /(?:^|\/)pr-chat['"]? hook$/.test(previous)))
        );
      });
    if (existing) {
      if (existing.command.startsWith(prefix) && existing.command !== command) {
        existing.command = command;
        changed = true;
      }
      continue;
    }
    const handler = {
      type: 'command',
      command,
      timeout: 25,
      ...(event.async ? { async: true } : {}),
    };
    groups.push({ ...(event.matcher ? { matcher: event.matcher } : {}), hooks: [handler] });
    changed = true;
  }
  return { file, data, changed, skillFile: join(directory, 'skills', 'pr-chat', 'SKILL.md') };
}

function writeSettings(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function init(target, port) {
  if (!['codex', 'claude', 'both'].includes(target))
    throw new Error('Usage: pr-chat init [codex|claude|both]');
  const agents = target === 'both' ? ['codex', 'claude'] : [target];
  for (const { file, data, changed, skillFile } of agents.map((agent) => plan(agent, port))) {
    if (changed) writeSettings(file, data);
    console.log(`${changed ? 'Configured' : 'Already configured'} ${file}`);
    mkdirSync(dirname(skillFile), { recursive: true, mode: 0o700 });
    try {
      copyFileSync(skill, skillFile, constants.COPYFILE_EXCL);
      console.log(`Installed ${skillFile}`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log(`Kept existing ${skillFile}`);
    }
  }
  console.log('Run pr-chat start if Review Relay is offline.');
  if (agents.includes('codex')) console.log('Open /hooks in Codex to review and trust new hooks.');
  if (agents.includes('claude'))
    console.log('Open or resume Claude Code and use /pr-chat <PR URL> to link it.');
}
