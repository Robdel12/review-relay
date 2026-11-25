#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { init } from './init.js';
import {
  chatReference,
  defaultReviewSkill,
  githubRepoFromRemote,
  parseChat,
  parsePR,
  uuid,
} from './protocol.js';

const origin = `http://127.0.0.1:${process.env.PR_CHAT_PORT || 4317}`;
const urlPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?![\w/])/gi;

async function api(path, body, timeout = 24_000) {
  const options = body
    ? {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { Origin: origin, 'Content-Type': 'application/json' },
      }
    : {};
  let response;
  try {
    response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new Error('Review Relay is unavailable. Run pr-chat start.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? data.error);
  return data;
}

function checkout(cwd, args) {
  if (typeof cwd !== 'string') return '';
  try {
    return execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function prFromPrompt(prompt, cwd) {
  const urls = [...new Set(prompt.match(urlPattern) ?? [])];
  if (urls.length === 1 && parsePR(urls[0])) return urls[0];
  if (urls.length) return null;
  const numbers = [
    ...new Set([...prompt.matchAll(/(?:\bPR\s*#?|#)\s*([1-9]\d*)\b/gi)].map((match) => match[1])),
  ];
  if (numbers.length !== 1) return null;
  const repo = githubRepoFromRemote(checkout(cwd, ['remote', 'get-url', 'origin']));
  return repo ? `https://github.com/${repo}/pull/${numbers[0]}` : null;
}

async function linksFromReviewPrompt({ prompt, cwd }, chat) {
  if (typeof prompt !== 'string') return [];
  const mentions = [...prompt.matchAll(/(?:^|[\s([`])[$/]([a-z0-9][a-z0-9_-]*)/gi)];
  if (!mentions.length) return [];
  const pr = prFromPrompt(prompt, cwd);
  if (!pr) return [];
  const { skill } = await api('/api/review-skill', undefined, 1200).catch(() => ({
    skill: defaultReviewSkill,
  }));
  return mentions.some(([, name]) => name.toLowerCase() === skill.toLowerCase())
    ? [{ pr, chat, expect: 'reviewer' }]
    : [];
}

function linksFromPRCreation(input, chat) {
  const { command, workdir, cwd } = input.tool_input ?? {};
  if (
    input.tool_name !== 'Bash' ||
    typeof command !== 'string' ||
    !/(?:^|[\s;&|])(?:\/opt\/homebrew\/bin\/)?gh\s+pr\s+create(?:\s|$)/.test(command)
  )
    return [];

  const response = input.tool_response;
  const text = typeof response === 'string' ? response : (response?.stdout ?? response?.output);
  const output = typeof text === 'string' ? text : JSON.stringify(response ?? '');
  const urls = [...new Set(output.match(urlPattern) ?? [])].filter((url) => parsePR(url));
  const opened =
    urls.length <= 1
      ? urls
      : [
          ...new Set(
            output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => parsePR(line)),
          ),
        ];
  const worktree = checkout(workdir ?? cwd ?? input.cwd, ['rev-parse', '--show-toplevel']);
  return worktree
    ? opened.map((pr) => ({ pr, chat, expect: 'author', auto: 'opened', worktree }))
    : [];
}

function hookLinks(input, provider) {
  const chat = chatReference({ provider, thread: input.session_id });
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return linksFromReviewPrompt(input, chat);
    case 'PostToolUse':
      return linksFromPRCreation(input, chat);
    default:
      return [];
  }
}

async function hook(provider = 'codex') {
  let input;
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 2_000_000) return;
    }
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof input?.session_id !== 'string' || !uuid.test(input.session_id) || input.agent_id)
    return;
  const event = input.hook_event_name;
  const links = await hookLinks(input, provider);
  const output = {};
  if (links.length) {
    const messages = await Promise.all(
      links.map(async (fields) => {
        try {
          const result = await api('/api/links', fields);
          return result.status === 'open'
            ? `Review Relay linked #${result.number} to this session.`
            : `Review Relay recorded #${result.number} as ${result.status}.`;
        } catch (error) {
          return `Review Relay could not link #${parsePR(fields.pr).number}. ${error.message}`;
        }
      }),
    );
    output.systemMessage = messages.join('\n');
  }
  if (provider === 'claude' && ['SessionStart', 'UserPromptSubmit'].includes(event)) {
    try {
      const { messages } = await api('/api/claude/feedback', { session: input.session_id }, 1200);
      if (messages.length) {
        output.hookSpecificOutput = {
          hookEventName: event,
          additionalContext: [
            'There’s new GitHub activity for the PR linked to this chat. Address it when it fits the user’s current request. Otherwise mention it briefly and continue with their task.',
            ...messages,
          ].join('\n\n'),
        };
      }
    } catch {
      // Claude can continue if the local app is offline.
    }
  }
  if (Object.keys(output).length) console.log(JSON.stringify(output));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'hook' && (args.length === 0 || args[0] === 'claude')) return hook(args[0]);
  if (command === 'init') return init(args[0] ?? 'both', process.env.PR_CHAT_PORT);
  if (command === 'start') return import('./app.js');
  if (command === 'list') {
    const data = await api('/api/state');
    for (const link of data.links) {
      console.log(
        `${link.status.padEnd(8)} ${link.role.padEnd(8)} https://github.com/${link.repo}/pull/${link.number}  ${chatReference(link)}`,
      );
    }
    return;
  }
  if (command === 'link') {
    const {
      positionals: [pr, chat],
      values,
    } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        thread: { type: 'string' },
        worktree: { type: 'string' },
        expect: { type: 'string' },
      },
    });
    const session =
      values.thread ??
      chat ??
      (process.env.CLAUDE_CODE_SESSION_ID
        ? `claude:${process.env.CLAUDE_CODE_SESSION_ID}`
        : process.env.CODEX_THREAD_ID);
    if (!parseChat(session))
      throw new Error(
        'Run this from a linked agent or pass a Codex chat link or claude:<session-id>.',
      );
    const result = await api('/api/links', {
      pr,
      chat: session,
      worktree: values.worktree,
      expect: values.expect,
    });
    console.log(`#${result.number} ${result.role} • ${result.status} • ${chatReference(result)}`);
    return;
  }
  if (command === 'unlink') {
    const pr = parsePR(args[0]);
    if (!pr) throw new Error('Pass the linked PR URL.');
    const state = await api('/api/state');
    const link = state.links.find(
      (link) => link.repo === pr.repo && link.number === pr.number && link.status === 'open',
    );
    if (!link) throw new Error('This PR has no active link.');
    await api(`/api/links/${link.id}`, {});
    console.log(`Stopped #${pr.number}.`);
    return;
  }
  if (command === 'cutover') {
    await api('/api/cutover', {});
    console.log('Switched this app from polling to push.');
    return;
  }
  if (command === 'dashboard') {
    console.log(origin);
    return;
  }
  console.log(
    'pr-chat init [codex|claude|both]\npr-chat start\npr-chat link <PR URL> [session reference] [--worktree <path>]\npr-chat unlink <PR URL>\npr-chat list\npr-chat dashboard\npr-chat cutover',
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
