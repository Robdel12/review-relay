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

  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      function finish(error, result) {
        socket.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result);
      }
      function onMessage(raw) {
        try {
          const message = JSON.parse(raw);
          if (message.id === id) {
            finish(message.error && new Error(`Codex ${method} failed`), message.result);
          }
        } catch (error) {
          finish(error);
        }
      }
      function onAbort() {
        finish(signal.reason);
      }
      signal.throwIfAborted();
      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) finish(error);
      });
    });
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
