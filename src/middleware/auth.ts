/**
 * Authentification.
 *
 * Deux mécanismes sont possibles, derrière la même interface :
 *  - `AccessCodeVerifier` : le code partagé `ACCESS_CODE` (en-tête
 *    `X-Access-Code`). C'est le mode de développement ;
 *  - un vérificateur de jeton d'identité (par exemple Firebase Admin SDK),
 *    à brancher plus tard : il n'est pas implémenté ici, l'interface est là
 *    pour que le remplacement se fasse sans toucher aux routes.
 *
 * Le vérificateur fournit une **identité** : c'est elle qui sert de clé de
 * quota (une identité = un quota), et non l'adresse IP.
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

/** Résultat d'une vérification d'accès. */
export interface AuthResult {
  /** `true` si l'accès est accordé. */
  ok: boolean;
  /**
   * Identité de l'appelant, quand elle est connue. Sert de clé de quota.
   * `null` si l'accès est accordé sans identité individuelle (code partagé).
   */
  identity: string | null;
  /** Raison du refus, pour les journaux. */
  reason?: string;
}

/**
 * Vérificateur d'accès.
 *
 * L'implémentation de référence est `AccessCodeVerifier`. Un vérificateur de
 * jeton d'identité s'y substitue sans modifier les routes.
 */
export interface AccessVerifier {
  /** Le mécanisme autorise-t-il un appel sans vérification ? */
  readonly optional: boolean;
  /** Vérifie l'accès et retourne l'identité de l'appelant. */
  verify(token: string | null): Promise<AuthResult>;
  /** Nom du mécanisme, pour les journaux. */
  readonly kind: string;
}

/** Mécanisme par code d'accès partagé (comparaison à temps constant). */
export class AccessCodeVerifier implements AccessVerifier {
  readonly optional = false;
  readonly kind = 'access_code';

  constructor(private readonly accessCode: string) {}

  async verify(token: string | null): Promise<AuthResult> {
    if (!token || !safeEqual(token, this.accessCode)) {
      return { ok: false, identity: null, reason: 'invalid_access_code' };
    }
    // Code partagé : pas d'identité individuelle.
    return { ok: true, identity: null };
  }
}

/**
 * Vérificateur qui laisse passer tout le monde.
 * Utilisé en développement et dans les tests.
 */
export class OpenVerifier implements AccessVerifier {
  readonly optional = true;
  readonly kind = 'open';

  async verify(): Promise<AuthResult> {
    return { ok: true, identity: null };
  }
}

/** Construit le vérificateur correspondant à la configuration. */
export function createVerifier(accessCode: string | null): AccessVerifier {
  return accessCode ? new AccessCodeVerifier(accessCode) : new OpenVerifier();
}

/**
 * Middleware d'authentification.
 *
 * `/api/health` reste accessible sans vérification (API-CONTRACT.md §2).
 */
export function auth(verifier: AccessVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (verifier.optional) {
      await next();
      return;
    }
    if (c.req.path === '/api/health') {
      await next();
      return;
    }

    const token = c.req.header('x-access-code') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
    const result = await verifier.verify(token);

    if (!result.ok) {
      throw new AppError('unauthorized');
    }

    c.set('identity', result.identity);
    await next();
  };
}
