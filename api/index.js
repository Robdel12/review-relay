import { defineCricketApp, respond } from '@robdel12/cricket';

const headers = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
});

export function createReviewApp({
  dependencies = {},
  origin = () => undefined,
  onShutdown,
  cleanup,
} = {}) {
  return defineCricketApp({
    name: 'Review Relay',
    version: '0.1.0',
    domains: new URL('./domains/', import.meta.url),
    logger: { service: 'review-relay', level: 'warn' },
    setup: () => ({ dependencies, cleanup }),
    responseHeaders: () => headers,
    requestPolicy({ request }) {
      const localOrigin = origin();
      if (`http://${request.headers.host}` !== localOrigin)
        return respond(403, { error: 'Use the local dashboard URL.' });
      if (
        request.method === 'POST' &&
        (request.headers.origin !== localOrigin ||
          request.headers['content-type'] !== 'application/json')
      ) {
        return respond(403, { error: 'This action is available only from the local dashboard.' });
      }
    },
    fallback: () => respond(404, { error: 'Page not found.' }),
    ...(onShutdown ? { onShutdown } : {}),
  });
}

export const app = createReviewApp();
