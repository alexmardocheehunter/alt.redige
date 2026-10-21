/**
 * Optional access code authentication.
 * When ACCESS_CODE is configured, every /api/* route except /api/health requires
 * the header `X-Access-Code`. The comparison is constant-time.
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors.js';
import type { AppEnv } from '../types.js';

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison of equal length to keep the timing constant-ish.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export function auth(accessCode: string | null): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!accessCode) return next();
    if (c.req.path === '/api/health') return next();

    const provided = c.req.header('x-access-code');
    if (!provided || !safeEqual(provided, accessCode)) {
      throw new AppError('unauthorized');
    }
    return next();
  };
}
