/**
 * In-memory sliding-window rate limiting, per IP and per bucket.
 * The server is stateless with respect to user data: only timestamps are kept here.
 */
import type { MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppError } from '../errors.js';
import type { AppEnv } from '../types.js';

interface Bucket {
  limit: number;
  windowMs: number;
  hits: Map<string, number[]>;
}

const buckets = new Map<string, Bucket>();

function bucket(name: string, limit: number, windowMs: number): Bucket {
  let existing = buckets.get(name);
  if (!existing) {
    existing = { limit, windowMs, hits: new Map() };
    buckets.set(name, existing);
  }
  return existing;
}

/** Resets every bucket. Used by the tests. */
export function resetRateLimits(): void {
  for (const b of buckets.values()) b.hits.clear();
}

export function clientIp(c: { req: { header: (name: string) => string | undefined }; env?: unknown }, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  try {
    const info = getConnInfo(c as never);
    if (info.remote.address) return info.remote.address;
  } catch {
    /* not running under the node-server adapter (tests) */
  }
  return 'unknown';
}

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowMs: number;
  trustProxy: boolean;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const { name, limit, windowMs, trustProxy } = options;
  const store = bucket(name, limit, windowMs);

  return async (c, next) => {
    const ip = clientIp(c as never, trustProxy);
    c.set('clientIp', ip);

    const now = Date.now();
    const cutoff = now - windowMs;
    const kept = (store.hits.get(ip) ?? []).filter((timestamp) => timestamp > cutoff);

    if (kept.length >= limit) {
      store.hits.set(ip, kept);
      const retryAfterSeconds = Math.max(1, Math.ceil((kept[0]! + windowMs - now) / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      throw new AppError('rate_limited');
    }

    kept.push(now);
    store.hits.set(ip, kept);
    await next();
  };
}
