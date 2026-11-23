import { DurableObject } from 'cloudflare:workers';
import { protocol, uuid, repoName, maxWebhook, normalizeLink, normalizeEvent, readBytes, verifyWebhook, safeEqual } from './protocol.js';

async function acceptGitHubEvent(request, env) {
  const type = request.headers.get('X-GitHub-Event');
  const id = request.headers.get('X-GitHub-Delivery');
  if (!uuid.test(id) || !['ping', 'pull_request', 'pull_request_review', 'pull_request_review_comment'].includes(type)) {
    return new Response(null, { status: 400 });
  }
  let payload;
  try {
    const raw = await readBytes(request.body, maxWebhook);
    if (!await verifyWebhook(raw, request.headers.get('X-Hub-Signature-256'), env.GITHUB_WEBHOOK_SECRET)) {
      return new Response(null, { status: 401 });
    }
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    return new Response(null, { status: error instanceof RangeError ? 413 : 400 });
  }
  const repo = payload?.repository?.full_name;
  const allowedRepo = env.GITHUB_REPOSITORY?.toLowerCase();
  if (type !== 'ping' && (!repoName.test(repo) || repo.toLowerCase() !== allowedRepo || !payload.installation?.id)) {
    return new Response(null, { status: 204 });
  }
  const inbox = env.INBOX.getByName('personal');
  return inbox.fetch('https://inbox.internal/event', { method: 'POST', body: JSON.stringify({ id, type, payload }) });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return new Response('Ready');
    if (path === '/github' && request.method === 'POST') {
      return acceptGitHubEvent(request, env);
    }
    if (path === '/stream' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const offers = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(value => value.trim()) ?? [];
      if (!env.BRIDGE_TOKEN || !offers.includes(protocol) || !offers.some(offer => safeEqual(offer, env.BRIDGE_TOKEN))) {
        return new Response(null, { status: 401 });
      }
      const inbox = env.INBOX.getByName('personal');
      return inbox.fetch(new Request('https://inbox.internal/stream', { headers: { Upgrade: 'websocket' } }));
    }
    return new Response(null, { status: 404 });
  },
};

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, repo TEXT, number INTEGER, login TEXT, role TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS subscription_pr ON subscriptions (repo, number);
      CREATE TABLE IF NOT EXISTS ended (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, received INTEGER NOT NULL, acknowledged INTEGER
      );
      CREATE INDEX IF NOT EXISTS pending_events ON events (acknowledged, received);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/stream') {
      const [client, server] = Object.values(new WebSocketPair());
      server.serializeAttachment({ synced: false });
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': protocol } });
    }

    const { id, type, payload } = await request.json();
    const now = Date.now();
    this.sql.exec("INSERT OR REPLACE INTO metadata VALUES ('webhook', ?)", now);
    if (type !== 'ping') {
      const repo = payload.repository.full_name.toLowerCase();
      const link = this.sql.exec('SELECT * FROM subscriptions WHERE repo = ? AND number = ?',
        repo, payload.pull_request?.number ?? 0).toArray()[0];
      if (link) {
        const event = normalizeEvent(type, payload, link);
        if (event) this.ctx.storage.transactionSync(() => {
          const eventId = `${link.id}:${id.toLowerCase()}`;
          const envelope = { ...event, id: eventId, link: link.id, received: now };
          this.sql.exec('INSERT OR IGNORE INTO events (id, content, received) VALUES (?, ?, ?)',
            eventId, JSON.stringify(envelope), now);
          if (event.kind === 'merged' || event.kind === 'closed') {
            this.sql.exec('INSERT OR IGNORE INTO ended VALUES (?)', link.id);
            this.sql.exec('DELETE FROM subscriptions WHERE id = ?', link.id);
          }
        });
      }
    }
    this.sql.exec('DELETE FROM events WHERE acknowledged < ?', now - 14 * 86400_000);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.synced) this.flush(socket);
    }
    return new Response(null, { status: 204 });
  }

  webSocketMessage(socket, value) {
    if (typeof value !== 'string' || value.length > 65_536) return socket.close(1009, 'Message too large');
    let message;
    try { message = JSON.parse(value); } catch { return socket.close(1003, 'Invalid message'); }
    if (message?.type === 'sync' && Array.isArray(message.links) && message.links.length <= 100) {
      const links = message.links.map(normalizeLink);
      if (links.some(link => !link)) return socket.close(1008, 'Invalid subscription');
      const allowedRepo = this.env.GITHUB_REPOSITORY?.toLowerCase();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM subscriptions');
        for (const { id, repo, number, login, role } of links) {
          if (repo !== allowedRepo) continue;
          this.sql.exec('INSERT OR IGNORE INTO subscriptions SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ended WHERE id = ?)',
            id, repo, number, login, role, id);
        }
      });
      for (const other of this.ctx.getWebSockets()) {
        if (other !== socket && other.deserializeAttachment()?.synced) other.close(1008, 'Replaced by another client');
      }
      socket.serializeAttachment({ synced: true });
      const accepted = this.sql.exec('SELECT id FROM subscriptions').toArray().map(row => row.id);
      socket.send(JSON.stringify({ type: 'synced', links: accepted, repo: allowedRepo ?? null }));
      this.flush(socket);
    }
    if (message?.type === 'ack' && socket.deserializeAttachment()?.synced &&
        Array.isArray(message.ids) && message.ids.length <= 100) {
      this.ctx.storage.transactionSync(() => {
        for (const id of message.ids) {
          if (typeof id === 'string' && id.length === 73) this.sql.exec('UPDATE events SET acknowledged = ? WHERE id = ?', Date.now(), id);
        }
      });
      this.flush(socket);
    }
  }

  flush(socket) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const events = this.sql.exec('SELECT content FROM events WHERE acknowledged IS NULL ORDER BY received, id LIMIT 100')
      .toArray().map(row => JSON.parse(row.content));
    const lastWebhook = this.sql.exec("SELECT value FROM metadata WHERE key = 'webhook'").toArray()[0]?.value ?? null;
    socket.send(JSON.stringify({ type: 'events', events, lastWebhook }));
  }
}
