/**
 * Assigns a request id to every request and echoes it in the response headers.
 * The id is the only correlation key used in the logs (never the content).
 */
import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : `req_${randomBytes(8).toString('hex')}`;
    c.set('requestId', id);
    c.set('startedAt', Date.now());
    c.header('X-Request-Id', id);
    await next();
  };
}
