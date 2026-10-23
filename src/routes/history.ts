/**
 * Contract histories — API-CONTRACT.md §3.6 to §3.9.
 *
 * These routes are mounted only when `HISTORY_ENABLED=1`. They require an
 * individual identity: a Firebase `uid`. A shared access code can still call
 * the chat, but it cannot read or write histories.
 */
import { Hono, type Context } from 'hono';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { HistoryInput, HistoryMessage, HistoryRecord, HistoryStore, HistorySummary } from '../history/store.js';
import type { Logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import type { AppEnv } from '../types.js';

export const MAX_HISTORY_ID_LENGTH = 64;
export const MAX_HISTORY_TITLE_LENGTH = 200;
export const MAX_HISTORY_CONTRACT_TYPE_LENGTH = 64;
export const MAX_HISTORY_MESSAGES = 30;
export const MAX_HISTORY_MESSAGE_LENGTH = 8000;
export const MAX_HISTORY_DOCUMENT_BYTES = 200_000;
export const HISTORY_LIST_LIMIT = 50;

const HISTORY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Les uid Google sont numériques ; on reste strict pour éviter tout chemin Firestore. */
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface HistoryDeps {
  config: AppConfig;
  logger: Logger;
  store: HistoryStore;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requireUid(c: Context<AppEnv>): string {
  const uid = c.get('identity');
  if (!uid) {
    throw new AppError(
      'unauthorized',
      'Connectez-vous avec Google pour accéder à vos historiques.',
    );
  }
  if (!UID_RE.test(uid)) {
    throw new AppError('unauthorized', undefined, 'invalid_uid');
  }
  return uid;
}

function historyId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? '';
  if (!HISTORY_ID_RE.test(id)) {
    throw new AppError('bad_request', 'Identifiant d’historique invalide.');
  }
  return id;
}

/** Validates the body of a PUT /api/history/:id request. */
export function parseHistoryBody(raw: unknown): HistoryInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('bad_request', 'Corps de requête invalide.');
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.title !== 'string') {
    throw new AppError('bad_request', 'Titre de l’historique manquant.');
  }
  const title = body.title.trim();
  if (title.length === 0 || title.length > MAX_HISTORY_TITLE_LENGTH) {
    throw new AppError('bad_request', 'Titre de l’historique invalide (200 caractères maximum).');
  }

  let contractType: string | null = null;
  if (body.contract_type !== null && body.contract_type !== undefined) {
    if (typeof body.contract_type !== 'string') {
      throw new AppError('bad_request', 'Type de contrat invalide.');
    }
    const candidate = body.contract_type.trim();
    if (candidate.length > MAX_HISTORY_CONTRACT_TYPE_LENGTH) {
      throw new AppError('bad_request', 'Type de contrat invalide.');
    }
    contractType = candidate.length > 0 ? candidate : null;
  }

  if (typeof body.markdown !== 'string') {
    throw new AppError('bad_request', 'Contenu du contrat manquant.');
  }
  if (byteLength(body.markdown) > MAX_HISTORY_DOCUMENT_BYTES) {
    throw new AppError('payload_too_large', 'Le document est trop long.');
  }

  const version = body.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 1_000_000) {
    throw new AppError('bad_request', 'Version du document invalide.');
  }

  if (!Array.isArray(body.messages)) {
    throw new AppError('bad_request', 'Historique de messages invalide.');
  }
  if (body.messages.length > MAX_HISTORY_MESSAGES) {
    throw new AppError('bad_request', 'Trop de messages : 30 maximum.');
  }

  const messages: HistoryMessage[] = [];
  for (const item of body.messages) {
    if (!item || typeof item !== 'object') {
      throw new AppError('bad_request', 'Message invalide.');
    }
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new AppError('bad_request', 'Rôle de message invalide.');
    }
    if (typeof message.content !== 'string') {
      throw new AppError('bad_request', 'Contenu de message invalide.');
    }
    if (message.content.length > MAX_HISTORY_MESSAGE_LENGTH) {
      throw new AppError('payload_too_large', 'Un message est trop long.');
    }
    messages.push({ role: message.role, content: message.content });
  }

  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.role === messages[index - 1]!.role) {
      throw new AppError('bad_request', 'Les rôles des messages doivent alterner.');
    }
  }

  return {
    title,
    contract_type: contractType,
    markdown: body.markdown,
    version,
    messages,
  };
}

function reportStoreFailure(logger: Logger, operation: string, error: unknown): never {
  if (error instanceof AppError) throw error;
  logger.error('history_store_failed', {
    operation,
    // Never log the Firestore message: it could echo a document fragment.
    error_kind: error instanceof Error ? error.name : typeof error,
  });
  throw new AppError('storage_unavailable');
}

export function historyRoutes({ config, logger, store }: HistoryDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', rateLimit({
    name: 'history',
    limit: config.rateHistoryPerMin,
    windowMs: 60 * 1000,
    trustProxy: config.trustProxy,
  }));

  app.get('/api/history', async (c) => {
    const uid = requireUid(c);
    let items: HistorySummary[];
    try {
      items = await store.list(uid, HISTORY_LIST_LIMIT);
    } catch (error) {
      reportStoreFailure(logger, 'list', error);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ items });
  });

  app.get('/api/history/:id', async (c) => {
    const uid = requireUid(c);
    const id = historyId(c);
    let record: HistoryRecord | null;
    try {
      record = await store.get(uid, id);
    } catch (error) {
      reportStoreFailure(logger, 'get', error);
    }
    if (!record) {
      throw new AppError('not_found', 'Historique introuvable.');
    }
    c.header('Cache-Control', 'no-store');
    return c.json(record);
  });

  app.put('/api/history/:id', async (c) => {
    const uid = requireUid(c);
    const id = historyId(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Corps JSON invalide.');
    }
    const input = parseHistoryBody(raw);

    let record: HistoryRecord;
    try {
      record = await store.put(uid, id, input);
    } catch (error) {
      reportStoreFailure(logger, 'put', error);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ id, updated_at: record.updated_at });
  });

  app.delete('/api/history/:id', async (c) => {
    const uid = requireUid(c);
    const id = historyId(c);
    try {
      await store.delete(uid, id);
    } catch (error) {
      reportStoreFailure(logger, 'delete', error);
    }
    return c.body(null, 204);
  });

  return app;
}
