/**
 * Access log: method, route, status and duration.
 * Never the body, the messages or the contract content.
 */
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../logger.js';
import type { AppEnv } from '../types.js';

export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      const status = c.res?.status ?? 0;
      const fields = {
        request_id: c.get('requestId') ?? '-',
        method: c.req.method,
        path: c.req.path,
        status,
        duration_ms: Date.now() - startedAt,
      };
      if (status >= 400) logger.warn('request', fields);
      else logger.info('request', fields);
    }
  };
}
