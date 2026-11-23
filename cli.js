#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parsePR, uuid } from './protocol.js';

const origin = `http://127.0.0.1:${process.env.PR_CHAT_PORT || 4317}`;
const urlPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*(?![\w/])/gi;

async function api(path, body) {
  const options = body ? {
    method: 'POST', body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json' },
  } : {};
  let response;
  try {
    response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(24_000) });
  } catch {
    throw new Error('PR Chat is not running on this Mac.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function checkout(cwd, args) {
  if (typeof cwd !== 'string') return '';
  try {
    return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function prFromPrompt(prompt, cwd) {
  const urls = [...new Set(prompt.match(urlPattern) ?? [])];
  if (urls.length === 1 && parsePR(urls[0])) return urls[0];
  if (urls.length) return null;
  const numbers = [...new Set([...prompt.matchAll(/(?:\bPR\s*#?|#)\s*([1-9]\d*)\b/gi)].map(match => match[1]))];
  if (numbers.length !== 1) return null;
  const remote = checkout(cwd, ['remote', 'get-url', 'origin']);
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/i
    .exec(remote.replace(/\.git$/, ''))?.[1];
  return repo ? `https://github.com/${repo}/pull/${numbers[0]}` : null;
}

function hookInput(input) {
  if (!uuid.test(input.session_id)) return null;
  if (input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string' &&
      /\$pull-request-review\b/i.test(input.prompt)) {
    const pr = prFromPrompt(input.prompt, input.cwd);
    return pr ? { pr, chat: input.session_id, expect: 'reviewer' } : null;
  }
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Bash' &&
      typeof input.tool_input?.command === 'string' &&
      /(?:^|[\s;&|])(?:\/opt\/homebrew\/bin\/)?gh\s+pr\s+create(?:\s|$)/.test(input.tool_input.command)) {
    const output = typeof input.tool_response === 'string' ? input.tool_response : JSON.stringify(input.tool_response ?? '');
    const urls = [...new Set(output.match(urlPattern) ?? [])].filter(url => parsePR(url));
    const cwd = input.tool_input.workdir ?? input.tool_input.cwd ?? input.cwd;
    const worktree = checkout(cwd, ['rev-parse', '--show-toplevel']);
    return urls.length === 1 && worktree
      ? { pr: urls[0], chat: input.session_id, expect: 'author', auto: 'opened', worktree }
      : null;
  }
  return null;
}

async function hook() {
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 2_000_000) return;
    }
    const fields = hookInput(JSON.parse(raw));
    if (!fields) return;
    const result = await api('/api/links', fields);
    console.log(JSON.stringify({ systemMessage: result.status === 'open'
      ? `PR Chat linked #${result.number} to this chat.`
      : `PR Chat recorded #${result.number} as ${result.status}.` }));
  } catch (error) {
    console.log(JSON.stringify({ systemMessage: `PR Chat could not link this PR. ${error.message}` }));
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'hook') return hook();
  if (command === 'list') {
    const data = await api('/api/state');
    for (const link of data.links) {
      console.log(`${link.status.padEnd(8)} ${link.role.padEnd(8)} https://github.com/${link.repo}/pull/${link.number}  codex://threads/${link.thread}`);
    }
    return;
  }
  if (command === 'link') {
    const { positionals: [pr, chat], values } = parseArgs({ args, allowPositionals: true, options: {
      thread: { type: 'string' }, worktree: { type: 'string' }, expect: { type: 'string' },
    } });
    const result = await api('/api/links', {
      pr, chat: values.thread ?? chat ?? process.env.CODEX_THREAD_ID,
      worktree: values.worktree, expect: values.expect,
    });
    console.log(`#${result.number} ${result.role} • ${result.status} • codex://threads/${result.thread}`);
    return;
  }
  if (command === 'unlink') {
    const pr = parsePR(args[0]);
    if (!pr) throw new Error('Pass the linked PR URL.');
    const state = await api('/api/state');
    const link = state.links.find(link => link.repo === pr.repo && link.number === pr.number && link.status === 'open');
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
  console.log('pr-chat link <PR URL> [chat link] [--worktree <path>]\npr-chat unlink <PR URL>\npr-chat list\npr-chat dashboard\npr-chat cutover');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
