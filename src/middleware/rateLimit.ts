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

/**
 * Client IP.
 *
 * Derrière un proxy inverse, l'adresse de la connexion est celle du proxy :
 * tous les clients se partagent alors le même quota. `trustProxy` permet de
 * lire `X-Forwarded-For` ; sans lui, une adresse privée ou de boucle locale
 * est signalée comme « proxy » et le quota retombe sur l'identité.
 */
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
    if (info.remote.address) {
      const address = info.remote.address;
      // 127.0.0.1, ::1, 10.x, 172.16-31.x, 192.168.x : on est derrière un proxy.
      if (isPrivateAddress(address)) return PROXY_IP;
      return address;
    }
  } catch {
    /* not running under the node-server adapter (tests) */
  }
  return 'unknown';
}

const PROXY_IP = 'proxy';

/** Le client est-il identifiable ? (adresse publique, pas un proxy). */
function isReliableAddress(address: string): boolean {
  return address !== PROXY_IP && address !== 'unknown';
}

function isPrivateAddress(address: string): boolean {
  const value = address.replace(/^::ffff:/, '');
  if (value === '127.0.0.1' || value === '::1') return true;
  if (value.startsWith('10.')) return true;
  if (value.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(value);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
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

    // Clé de quota : l'identité quand elle existe, l'adresse IP sinon.
    // Derrière un proxy sans `TRUST_PROXY=1`, l'adresse IP est celle du
    // proxy : elle n'identifie pas le client. On ne peut donc pas en faire
    // une clé individuelle — le quota retombe sur l'identité, ou sur un seau
    // partagé explicitement identifié.
    const identity = c.get('identity') ?? null;
    const key = identity
      ? `id:${identity}`
      : isReliableAddress(ip)
        ? `ip:${ip}`
        : `shared:${name}`;

    const now = Date.now();
    const cutoff = now - windowMs;
    const kept = (store.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

    if (kept.length >= limit) {
      store.hits.set(key, kept);
      const retryAfterSeconds = Math.max(1, Math.ceil((kept[0]! + windowMs - now) / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      throw new AppError('rate_limited');
    }

    kept.push(now);
    store.hits.set(key, kept);
    await next();
  };
}
