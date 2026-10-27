/**
 * Company profiles — API-CONTRACT.md §3.10.
 *
 * Every route requires an individual Firebase identity. A shared access code
 * can still use the chat, but it cannot read or write company profiles.
 */
import { Hono, type Context } from 'hono';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import type { AppEnv } from '../types.js';
import {
  CompanyProfileLimitError,
  type CompanyProfile,
  type CompanyProfileInput,
  type CompanyProfileStore,
} from '../company/store.js';
import {
  CompanyProfileValidationError,
  completeProfileInput,
  isValidCompanyId,
  parseCompanyProfileFields,
} from '../company/profile.js';

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface CompanyRoutesDeps {
  config: AppConfig;
  logger: Logger;
  store: CompanyProfileStore;
}

function requireUid(c: Context<AppEnv>): string {
  const uid = c.get('identity');
  if (!uid) {
    throw new AppError(
      'unauthorized',
      'Connectez-vous avec Google pour accéder à votre profil entreprise.',
    );
  }
  if (!UID_RE.test(uid)) {
    throw new AppError('unauthorized', undefined, 'invalid_uid');
  }
  return uid;
}

function profileId(c: Context<AppEnv>): string {
  const id = c.req.param('id') ?? '';
  if (!isValidCompanyId(id)) {
    throw new AppError('bad_request', 'Identifiant de profil invalide.');
  }
  return id;
}

function reportStoreFailure(logger: Logger, operation: string, error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof CompanyProfileLimitError) {
    throw new AppError('bad_request', 'Vous avez atteint la limite de cinq profils d’entreprise.');
  }
  logger.error('company_profile_store_failed', {
    operation,
    // Never log the Firestore message: it could echo a profile value.
    error_kind: error instanceof Error ? error.name : typeof error,
  });
  throw new AppError(
    'storage_unavailable',
    'Le stockage de votre profil d’entreprise est momentanément indisponible. Réessayez.',
  );
}

function validationError(error: CompanyProfileValidationError): never {
  throw new AppError(error.code, error.message);
}

export function companyRoutes({ config, logger, store }: CompanyRoutesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', rateLimit({
    name: 'company',
    limit: config.rateHistoryPerMin,
    windowMs: 60 * 1000,
    trustProxy: config.trustProxy,
  }));

  app.get('/api/company-profiles', async (c) => {
    const uid = requireUid(c);
    let items: CompanyProfile[];
    try {
      items = await store.list(uid);
    } catch (error) {
      reportStoreFailure(logger, 'list', error);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ items });
  });

  app.put('/api/company-profiles/:id', async (c) => {
    const uid = requireUid(c);
    const id = profileId(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Corps JSON invalide.');
    }

    let input: CompanyProfileInput;
    try {
      const parsed = parseCompanyProfileFields(raw, { partial: false });
      input = completeProfileInput(parsed.fields, parsed.isDefault);
    } catch (error) {
      if (error instanceof CompanyProfileValidationError) validationError(error);
      throw error;
    }

    let profile: CompanyProfile;
    try {
      profile = await store.put(uid, id, input);
    } catch (error) {
      reportStoreFailure(logger, 'put', error);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ profile });
  });

  app.delete('/api/company-profiles/:id', async (c) => {
    const uid = requireUid(c);
    const id = profileId(c);
    try {
      await store.delete(uid, id);
    } catch (error) {
      reportStoreFailure(logger, 'delete', error);
    }
    return c.body(null, 204);
  });

  app.delete('/api/company-profiles', async (c) => {
    const uid = requireUid(c);
    try {
      await store.deleteAll(uid);
    } catch (error) {
      reportStoreFailure(logger, 'delete_all', error);
    }
    return c.body(null, 204);
  });

  return app;
}
