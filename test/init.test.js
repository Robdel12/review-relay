import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('init installs both agents without replacing existing hooks, settings or a custom skill', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'review-relay-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codex = join(dir, 'codex settings');
  const claude = join(dir, "claude's settings");
  const hooks = join(codex, 'hooks.json');
  const settings = join(claude, 'settings.json');
  const personal = join(codex, 'skills', 'pr-chat', 'SKILL.md');
  const installed = join(claude, 'skills', 'pr-chat', 'SKILL.md');
  const env = { ...process.env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, PR_CHAT_PORT: '1' };
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const original = { hooks: [{ type: 'command', command: 'echo existing' }] };
  await mkdir(join(codex, 'skills', 'pr-chat'), { recursive: true });
  await mkdir(claude, { recursive: true });
  await writeFile(personal, 'My personal skill');
  await writeFile(hooks, JSON.stringify({ hooks: { UserPromptSubmit: [original] } }));
  await writeFile(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [original] } }));

  execFileSync(process.execPath, [cli, 'init'], { env });
  const codexConfig = await readFile(hooks, 'utf8');
  const claudeConfig = await readFile(settings, 'utf8');
  assert.equal(await readFile(personal, 'utf8'), 'My personal skill');
  assert.match(await readFile(installed, 'utf8'), /CLAUDE_CODE_SESSION_ID/);
  assert.deepEqual(JSON.parse(codexConfig).hooks.UserPromptSubmit[0], original);
  const { theme, hooks: claudeHooks } = JSON.parse(claudeConfig);
  assert.equal(theme, 'dark');
  assert.deepEqual(claudeHooks.Stop, [original]);
  const handler = claudeHooks.SessionStart[0].hooks[0];
  assert.equal(handler.async, undefined);
  assert.equal(execFileSync('/bin/sh', ['-c', handler.command], {
    input: '{}',
    encoding: 'utf8',
  }), '');

  execFileSync(process.execPath, [cli, 'init'], { env });
  assert.equal(await readFile(hooks, 'utf8'), codexConfig);
  assert.equal(await readFile(settings, 'utf8'), claudeConfig);
});
