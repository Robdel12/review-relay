import { readFile } from 'node:fs/promises';
import { defineEndpoint, respond, z } from '@robdel12/cricket';
import { uuid } from '../../../protocol.js';
import { InputError } from './input-error.js';

export const dashboardState = defineEndpoint({
  method: 'GET',
  path: '/api/state',
  summary: 'Read watches and recent deliveries',
  handler: ({ services }) => services.reviews.view(),
});

export const dashboardStream = defineEndpoint({
  method: 'GET',
  path: '/stream',
  summary: 'Stream dashboard updates',
  fetchResponses: { 200: { contentTypes: ['text/event-stream'] } },
  fetch: (_request, { services }) =>
    new Response(services.reviews.subscribe(), {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
});

export const dashboardAssets = [
  ['/', 'index.html', 'text/html'],
  ['/styles.css', 'styles.css', 'text/css'],
  ['/ui.js', 'ui.js', 'text/javascript'],
].map(([path, file, contentType]) =>
  defineEndpoint({
    method: 'GET',
    path,
    fetchResponses: { 200: { contentTypes: [contentType] } },
    async fetch() {
      return new Response(await readFile(new URL(`../../../public/${file}`, import.meta.url)), {
        headers: { 'Content-Type': `${contentType}; charset=utf-8` },
      });
    },
  }),
);

const empty = z.object({});
const success = Object.freeze({ ok: true });
const role = z.enum(['author', 'reviewer']);
const watchId = z.object({ id: z.string().regex(uuid) });
const deliveryId = z.object({ id: z.string().regex(/^[a-f0-9:-]+$/) });

function mutation(path, summary, body, handler, params) {
  return defineEndpoint({
    method: 'POST',
    path,
    summary,
    body,
    ...(params ? { params } : {}),
    maxBodyBytes: 16_384,
    async handler({ input, services }) {
      try {
        return respond(200, (await handler(services.reviews, input.body, input.params)) ?? success);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        return respond(error.status, { error: error.message });
      }
    },
  });
}

export const link = mutation(
  '/api/links',
  'Link a pull request to a chat',
  z.object({
    pr: z.string(),
    chat: z.string(),
    worktree: z.string().optional(),
    expect: role.optional(),
    auto: z.literal('opened').optional(),
  }),
  (reviews, body) => reviews.linkPR(body),
);

export const stop = mutation(
  '/api/links/:id',
  'Stop watching a pull request',
  empty,
  (reviews, _body, { id }) => reviews.unlinkPR(id),
  watchId,
);

export const retry = mutation(
  '/api/retry/:id',
  'Retry or requeue a delivery',
  z.object({ status: z.string().optional(), sentAt: z.number().int().nullable().optional() }),
  (reviews, body, { id }) => reviews.retryDelivery(id, body),
  deliveryId,
);

export const claude = mutation(
  '/api/claude/feedback',
  'Pick up feedback for a Claude Code session',
  z.object({ session: z.string().regex(uuid) }),
  (reviews, body) => reviews.takeClaudeFeedback(body),
);

export const polling = mutation(
  '/api/polling',
  'Change the polling interval',
  z.object({ minutes: z.number() }),
  (reviews, { minutes }) => reviews.setPolling(minutes),
);

export const reviewDiscovery = mutation(
  '/api/review-discovery',
  'Configure fresh review chats',
  z.object({ provider: z.enum(['off', 'codex', 'claude']), cwd: z.string().optional() }),
  (reviews, body) => reviews.discovery.configure(body),
);

export const pair = mutation(
  '/api/pair',
  'Pair a webhook relay',
  z.object({ url: z.string(), token: z.string() }),
  (reviews, body) => reviews.pair(body),
);

export const cutover = mutation(
  '/api/cutover',
  'Switch from polling to webhooks',
  empty,
  (reviews) => reviews.cutover(),
);
