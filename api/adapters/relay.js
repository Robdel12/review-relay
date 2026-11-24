import { normalizeLink, protocol } from '../../protocol.js';

export function createRelay(store) {
  let socket;
  let reconnectTimer;
  let delay = 1000;
  let status = 'unpaired';
  let accepted = new Set();
  let lastWebhook = null;
  let repo = null;
  let closed = false;
  let generation = 0;

  const view = () => ({ status, lastWebhook, repo });
  const subscribed = (id) => accepted.has(id);

  async function sync() {
    const current = socket;
    if (current?.readyState !== WebSocket.OPEN) return;
    const links = await store.read((rows) => rows.openWatches().map(normalizeLink));
    if (socket === current && current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify({ type: 'sync', links }));
    }
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    generation += 1;
    const previous = socket;
    socket = null;
    previous?.close();
  }

  async function connect({ receive, changed, logger }, reset = false) {
    if (closed) return;
    disconnect();
    if (reset) delay = 1000;
    const activeGeneration = generation;
    const { url, token } = await store.read((rows) => ({
      url: rows.setting('relay-url'),
      token: rows.setting('relay-token'),
    }));
    if (generation !== activeGeneration) return;
    accepted = new Set();
    repo = null;
    lastWebhook = null;
    status = url ? 'connecting' : 'unpaired';
    changed();
    if (!url) return;

    const endpoint = new URL('/stream', url);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(endpoint, [protocol, token]);
    socket = connection;
    const deadline = setTimeout(() => {
      if (socket === connection && status !== 'connected') connection.close();
    }, 10_000);
    const failed = (error) => {
      logger.warn('relay.message.failed', { error: error.name });
      connection.close();
    };

    connection.addEventListener('open', () => {
      if (socket === connection) sync().catch(failed);
    });
    let messages = Promise.resolve();
    connection.addEventListener('message', ({ data }) => {
      messages = messages
        .then(async () => {
          if (socket !== connection || typeof data !== 'string') return;
          const message = JSON.parse(data);
          if (message.type === 'synced' && Array.isArray(message.links)) {
            clearTimeout(deadline);
            status = 'connected';
            delay = 1000;
            accepted = new Set(message.links);
            repo = message.repo ?? null;
          } else if (
            message.type === 'events' &&
            Array.isArray(message.events) &&
            message.events.length <= 100
          ) {
            lastWebhook = message.lastWebhook;
            const ids = await receive(message.events);
            if (ids.length && socket === connection && connection.readyState === WebSocket.OPEN) {
              connection.send(JSON.stringify({ type: 'ack', ids }));
            }
          }
          changed();
        })
        .catch(failed);
    });
    connection.addEventListener('error', () => {});
    connection.addEventListener('close', () => {
      clearTimeout(deadline);
      if (socket !== connection) return;
      socket = null;
      accepted.clear();
      status = 'offline';
      changed();
      reconnectTimer = setTimeout(() => connect({ receive, changed, logger }).catch(failed), delay);
      delay = Math.min(delay * 2, 30_000);
    });
  }

  return Object.freeze({
    view,
    subscribed,
    sync,
    connect,
    close() {
      closed = true;
      disconnect();
    },
  });
}
