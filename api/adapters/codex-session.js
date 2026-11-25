import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { uuid } from '../../protocol.js';

async function withCodexServer({ codex, codexHome, cwd }, run) {
  const child = spawn(codex, ['app-server', '--listen', 'stdio://'], {
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const messages = createInterface({ input: child.stdout });
  const lifetime = new AbortController();
  const timeout = AbortSignal.timeout(20_000);
  const signal = AbortSignal.any([lifetime.signal, timeout]);
  child.on('error', (error) => lifetime.abort(error));
  child.stdin.on('error', (error) => lifetime.abort(error));
  child.stdout.on('error', (error) => lifetime.abort(error));
  child.once('exit', () => lifetime.abort(new Error('Codex app-server disconnected')));

  let sequence = 0;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  async function request(method, params) {
    signal.throwIfAborted();
    const id = ++sequence;
    const { promise, resolve, reject } = Promise.withResolvers();
    const abort = () => reject(signal.reason);
    function onMessage(raw) {
      try {
        const message = JSON.parse(raw);
        if (message.id !== id) return;
        if (message.error) throw new Error(`Codex ${method} failed`);
        resolve(message.result);
      } catch (error) {
        reject(error);
      }
    }

    signal.addEventListener('abort', abort, { once: true });
    messages.on('line', onMessage);
    try {
      send({ id, method, params });
      return await promise;
    } finally {
      messages.off('line', onMessage);
      signal.removeEventListener('abort', abort);
    }
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'review-relay', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized' });
    const result = await run(request);
    const closed = once(child, 'close', { signal: timeout });
    child.stdin.end();
    const [code] = await closed;
    if (code !== 0) throw new Error('Codex app-server did not shut down cleanly');
    return result;
  } finally {
    messages.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

async function projectForCheckout(request, cwd) {
  let cursor = null;
  do {
    const { data, nextCursor } = await request('project/list', { cursor, limit: 50 });
    const project = data.find((entry) => entry.roots.some((root) => root.path === cwd));
    if (project) return project.id;
    cursor = nextCursor;
  } while (cursor);
  return null;
}

export async function prepareCodexReview({ codex, codexHome, cwd, title, text, skill, model }) {
  const server = { codex, codexHome, cwd };
  const threadId = await withCodexServer(server, async (request) => {
    const projectId = await projectForCheckout(request, cwd);
    const { thread } = await request('thread/start', {
      cwd,
      model,
      projectId,
      historyMode: 'paginated',
    });
    if (!uuid.test(thread?.id)) throw new Error('Invalid Codex chat ID');
    await request('thread/name/set', { threadId: thread.id, name: title });
    return thread.id;
  });

  // Wait for the creator to release the writer lock before enqueueing the first turn.
  await withCodexServer(server, async (request) => {
    const { thread } = await request('thread/read', { threadId, includeTurns: false });
    if (thread?.id !== threadId) throw new Error('Codex chat was not saved');
    await request('thread/queue/add', {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text }, ...(skill ? [skill] : [])],
    });
  });
  return { thread: threadId };
}
