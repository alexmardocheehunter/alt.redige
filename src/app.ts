/**
 * HTTP application factory.
 * Kept separate from server.ts so the tests can build an app without opening a socket.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { AppConfig } from './config.js';
import { AppError, errorBody, isAppError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { requestId } from './middleware/requestId.js';
import { auth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import type { AppEnv } from './types.js';
import { TemplateStore } from './templates.js';
import { metaRoutes } from './routes/meta.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  /** Injected by the tests; loaded from data/templates otherwise. */
  templates?: TemplateStore;
}

const PUBLIC_INDEX = resolve(process.cwd(), 'public', 'index.html');

interface CachedFile {
  mtimeMs: number;
  body: Buffer;
}

let cachedIndex: CachedFile | null = null;

export function readIndexHtml(): Buffer | null {
  try {
    const stats = statSync(PUBLIC_INDEX);
    if (cachedIndex && cachedIndex.mtimeMs === stats.mtimeMs) return cachedIndex.body;
    const body = readFileSync(PUBLIC_INDEX);
    cachedIndex = { mtimeMs: stats.mtimeMs, body };
    return body;
  } catch {
    return null;
  }
}

export function createApp({ config, logger, templates }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  let templateStore = templates;
  if (!templateStore) {
    try {
      templateStore = TemplateStore.load();
    } catch (error) {
      templateStore = new TemplateStore([]);
      logger.error('templates_unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  app.use('*', requestId());
  app.use('*', secureHeaders({
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
  }));

  if (config.allowedOrigin) {
    app.use('/api/*', cors({
      origin: config.allowedOrigin,
      allowHeaders: ['Content-Type', 'X-Access-Code', 'X-Request-Id'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      maxAge: 600,
    }));
  }

  app.use('/api/*', auth(config.accessCode));

  app.use('/api/*', bodyLimit({
    maxSize: config.maxBodyBytes,
    onError: (c) => c.json(errorBody('payload_too_large', 'Le document ou le message est trop long.'), 413),
  }));

  app.onError((err, c) => {
    const requestIdValue = c.get('requestId') ?? '-';
    if (isAppError(err)) {
      logger.warn('request_rejected', {
        request_id: requestIdValue,
        code: err.code,
        path: c.req.path,
        detail: err.detail,
      });
      return c.json(errorBody(err.code, err.userMessage), err.status as never);
    }
    logger.error('unhandled_error', {
      request_id: requestIdValue,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
    });
    const appError = new AppError('internal');
    return c.json(errorBody(appError.code, appError.userMessage), 500);
  });

  app.notFound((c) => {
    const requestIdValue = c.get('requestId') ?? '-';
    logger.info('not_found', { request_id: requestIdValue, path: c.req.path });
    if (c.req.path.startsWith('/api/')) {
      return c.json(errorBody('bad_request', 'Ressource introuvable.'), 404);
    }
    return c.text('Page introuvable.', 404, { 'Content-Type': 'text/plain; charset=utf-8' });
  });

  app.route('/', metaRoutes({ config, logger, templates: templateStore }));

  // Rate limiting is attached per route, with the bucket and window required by the contract.
  app.use('/api/chat', rateLimit({
    name: 'chat',
    limit: config.rateChatPerHour,
    windowMs: 60 * 60 * 1000,
    trustProxy: config.trustProxy,
  }));

  app.get('/', (c) => {
    const body = readIndexHtml();
    if (!body) {
      return c.text('Interface indisponible.', 503, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return c.body(body as unknown as ArrayBuffer, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}
