import { once } from 'node:events';
import WebSocket from 'ws';
import { uuid } from '../../protocol.js';

export async function startCodexReview({ socketPath, cwd, title, text, skill, model }) {
  const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 5000 });
  let sequence = 0;
  const lifetime = new AbortController();
  socket.on('error', (error) => lifetime.abort(error));
  socket.once('close', () => lifetime.abort(new Error('Codex disconnected')));
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]);

  async function request(method, params) {
    signal.throwIfAborted();
    const id = ++sequence;
    const { promise, resolve, reject } = Promise.withResolvers();
    const onAbort = () => reject(signal.reason);

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

    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('message', onMessage);
    try {
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) reject(error);
      });
      return await promise;
    } finally {
      socket.off('message', onMessage);
      signal.removeEventListener('abort', onAbort);
    }
  }

  try {
    await once(socket, 'open', { signal });
    await request('initialize', { clientInfo: { name: 'review-relay', version: '0.1.0' } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    const { thread } = await request('thread/start', { cwd, model });
    if (!uuid.test(thread?.id)) throw new Error('Invalid Codex chat ID');
    await request('thread/name/set', { threadId: thread.id, name: title });
    await request('turn/start', {
      threadId: thread.id,
      model,
      input: [{ type: 'text', text }, ...(skill ? [skill] : [])],
    });
    return { thread: thread.id };
  } finally {
    socket.close();
  }
}
