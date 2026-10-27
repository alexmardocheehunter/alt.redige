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
import { createOpenRouterClient, type LlmClient } from './llm.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { auth, createVerifier, FirebaseTokenVerifier, type AccessVerifier } from './middleware/auth.js';
import { applyNonce, contentSecurityPolicy } from './middleware/csp.js';
import { rateLimit } from './middleware/rateLimit.js';
import type { AppEnv } from './types.js';
import { TemplateStore } from './templates.js';
import { initFirebase } from './firebase.js';
import { FirestoreHistoryStore } from './history/firestore.js';
import type { HistoryStore } from './history/store.js';
import { FirestoreCompanyProfileStore } from './company/firestore.js';
import type { CompanyProfileStore } from './company/store.js';
import { metaRoutes } from './routes/meta.js';
import { chatRoutes } from './routes/chat.js';
import { exportRoutes } from './routes/export.js';
import { historyRoutes } from './routes/history.js';
import { companyRoutes } from './routes/company.js';

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  /** Injected by the tests; loaded from data/templates otherwise. */
  templates?: TemplateStore;
  /** Injected by the tests; built from the API key otherwise. */
  client?: LlmClient;
  /** Test hook: observes the tool calls (used by the evaluations). */
  onToolCall?: (name: string, input: unknown) => void;
  /** Injected by the tests; built from AUTH_MODE otherwise. */
  verifier?: AccessVerifier;
  /** Injected by the tests; a Firestore store is built when histories are enabled. */
  historyStore?: HistoryStore;
  /** Injected by the tests; a Firestore store is built when Firebase is configured. */
  companyProfileStore?: CompanyProfileStore;
}

const PUBLIC_INDEX = resolve(process.cwd(), 'public', 'index.html');

/** Returns the origin of PUBLIC_API_BASE, or null when it is absent/invalid. */
function publicApiOriginOf(publicApiBase: string | null): string | null {
  if (!publicApiBase) return null;
  try {
    return new URL(publicApiBase).origin;
  } catch {
    return null;
  }
}

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

export function createApp({
  config,
  logger,
  templates,
  client,
  onToolCall,
  verifier,
  historyStore,
  companyProfileStore,
}: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const publicApiOrigin = publicApiOriginOf(config.publicApiBase);

  // Firebase is initialised only when the current configuration needs it, so
  // the tests and the historical `AUTH_MODE=code` mode never touch credentials.
  const needsFirebaseAuth = !verifier && config.authMode !== 'code';
  const needsFirestore = !historyStore && config.historyEnabled;
  const firebase = needsFirebaseAuth || needsFirestore ? initFirebase(config) : null;

  let accessVerifier: AccessVerifier;
  if (verifier) {
    accessVerifier = verifier;
  } else if (config.authMode === 'code') {
    accessVerifier = createVerifier({ mode: 'code', accessCode: config.accessCode });
  } else {
    if (!firebase) throw new Error('Firebase n’est pas initialisé.');
    const firebaseVerifier = new FirebaseTokenVerifier((token) => firebase.auth.verifyIdToken(token));
    accessVerifier = config.authMode === 'firebase'
      ? createVerifier({ mode: 'firebase', firebase: firebaseVerifier })
      : createVerifier({ mode: 'hybrid', firebase: firebaseVerifier, accessCode: config.accessCode });
  }

  const store: HistoryStore | null = historyStore ?? (config.historyEnabled && firebase
    ? new FirestoreHistoryStore(firebase.db, {
      retentionDays: config.historyRetentionDays,
      maxPerUser: config.historyMaxPerUser,
    })
    : null);

  const companyStore: CompanyProfileStore | null = companyProfileStore
    ?? (firebase ? new FirestoreCompanyProfileStore(firebase.db) : null);

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
  app.use('*', requestLogger(logger));
  app.use('*', contentSecurityPolicy(publicApiOrigin));
  app.use('*', secureHeaders({
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
    // Firebase signInWithPopup receives its result through the popup's
    // `window.opener`. The default `same-origin` COOP severs that link, so the
    // popup closes after Google consent but the page never gets the session.
    // `same-origin-allow-popups` keeps isolation while allowing OAuth popups.
    crossOriginOpenerPolicy: 'same-origin-allow-popups',
    // HSTS en production uniquement : en développement le serveur est en HTTP
    // et l'en-tête n'aurait aucun effet, en production il évite qu'une
    // première visite en clair ne soit détournée.
    ...(config.nodeEnv === 'production'
      ? { strictTransportSecurity: 'max-age=31536000; includeSubDomains' }
      : {}),
    permissionsPolicy: {
      geolocation: [],
      microphone: [],
      camera: [],
      payment: [],
      usb: [],
    },
  }));

  if (config.allowedOrigins.length > 0) {
    app.use('/api/*', cors({
      // The page can be served from Firebase Hosting (`web.app` and
      // `firebaseapp.com`) while API calls target Cloud Run directly.
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'X-Access-Code', 'X-Request-Id', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      exposeHeaders: ['Content-Disposition'],
      maxAge: 600,
    }));
  }

  app.use('/api/*', auth(accessVerifier));

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
      return c.json(errorBody('not_found', 'Ressource introuvable.'), 404);
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

  app.route('/', chatRoutes({
    config,
    logger,
    templates: templateStore,
    client: client ?? createOpenRouterClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      siteUrl: config.siteUrl,
      appTitle: config.appTitle,
    }),
    onToolCall,
    companyStore,
  }));

  // Rate limiting is attached per route, with the bucket and window required by the contract.
  app.use('/api/export/docx', rateLimit({
    name: 'export',
    limit: config.rateExportPerMin,
    windowMs: 60 * 1000,
    trustProxy: config.trustProxy,
  }));

  app.route('/', exportRoutes({ config, logger }));

  if (config.historyEnabled) {
    if (!store) throw new Error('Le stockage des historiques n’est pas initialisé.');
    app.route('/', historyRoutes({ config, logger, store }));
  }

  if (companyStore) {
    app.route('/', companyRoutes({ config, logger, store: companyStore }));
  }

  app.get('/favicon.ico', (c) => c.body(null, 204));

  app.get('/', (c) => {
    const body = readIndexHtml();
    if (!body) {
      return c.text('Interface indisponible.', 503, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    // The page carries an inline script: the nonce of the response authorises it.
    let html = body.toString('utf8');
    if (config.publicApiBase) {
      // Runtime setting: the same page works same-origin locally, and calls
      // Cloud Run directly when served through Firebase Hosting (SSE-safe).
      html = html.replace("API_BASE: ''", `API_BASE: ${JSON.stringify(config.publicApiBase)}`);
    }
    const nonce = c.get('cspNonce');
    if (nonce) html = applyNonce(html, nonce);
    return c.body(html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}
