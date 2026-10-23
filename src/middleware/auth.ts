/**
 * Authentification.
 *
 * Trois mécanismes, derrière la même interface :
 *  - `AccessCodeVerifier` : le code partagé `ACCESS_CODE` (en-tête
 *    `X-Access-Code`). C'est le mode historique ;
 *  - `FirebaseTokenVerifier` : vérifie un jeton d'identité Firebase
 *    (`Authorization: Bearer <idToken>`) avec le SDK Admin. L'identité est
 *    l'`uid` Firebase, seule clé possible pour les historiques ;
 *  - `HybridVerifier` : accepte l'un ou l'autre, pour la transition du
 *    frontend. Un jeton Firebase valide fournit toujours l'`uid` ; un code
 *    partagé fournit une identité `null`.
 *
 * Le vérificateur fournit une **identité** : c'est elle qui sert de clé de
 * quota (une identité = un quota), et non l'adresse IP.
 *
 * Aucun jeton ni code n'est journalisé.
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
 * L'implémentation de référence est `AccessCodeVerifier`. Le vérificateur
 * Firebase s'y substitue sans modifier les routes.
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
 * Utilisé en développement et dans les tests, jamais en production.
 */
export class OpenVerifier implements AccessVerifier {
  readonly optional = true;
  readonly kind = 'open';

  async verify(): Promise<AuthResult> {
    return { ok: true, identity: null };
  }
}

/** Fonction injectable pour tester le vérificateur sans SDK Firebase. */
export type IdTokenVerifier = (token: string) => Promise<{ uid: string }>;

/**
 * Vérificateur de jetons d'identité Firebase.
 *
 * `verifyIdToken` est injecté : en production il s'agit de
 * `getAuth(app).verifyIdToken`, dans les tests d'un faux vérificateur.
 * On ne demande pas `checkRevoked` à chaque requête : cela ajouterait un appel
 * réseau par message. La révocation est donc effective au plus tard à
 * l'expiration du jeton (une heure).
 */
export class FirebaseTokenVerifier implements AccessVerifier {
  readonly optional = false;
  readonly kind = 'firebase';

  constructor(private readonly verifyIdToken: IdTokenVerifier) {}

  async verify(token: string | null): Promise<AuthResult> {
    if (!token) {
      return { ok: false, identity: null, reason: 'missing_token' };
    }
    try {
      const decoded = await this.verifyIdToken(token);
      if (!decoded.uid) {
        return { ok: false, identity: null, reason: 'missing_uid' };
      }
      return { ok: true, identity: decoded.uid };
    } catch (error) {
      return { ok: false, identity: null, reason: firebaseErrorReason(error) };
    }
  }
}

/** Code d'erreur Firebase Admin, sans message ni jeton. */
function firebaseErrorReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('auth/') ? code : 'invalid_firebase_token';
}

/** Un jeton d'identité Firebase est un JWT à trois segments. */
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Vérificateur de transition : jeton Firebase d'abord, code partagé ensuite.
 *
 * - jeton JWT valide → identité = uid ;
 * - jeton JWT invalide + code valide → identité = null (mode historique) ;
 * - code seul → identité = null ;
 * - aucun des deux → refus.
 */
export class HybridVerifier implements AccessVerifier {
  readonly optional = false;
  readonly kind = 'hybrid';

  constructor(
    private readonly firebase: AccessVerifier,
    private readonly accessCode: AccessVerifier,
  ) {}

  async verify(token: string | null): Promise<AuthResult> {
    if (!token) {
      return { ok: false, identity: null, reason: 'missing_token' };
    }

    if (looksLikeJwt(token)) {
      const firebaseResult = await this.firebase.verify(token);
      if (firebaseResult.ok) return firebaseResult;
      const codeResult = await this.accessCode.verify(token);
      return codeResult.ok ? codeResult : firebaseResult;
    }

    const codeResult = await this.accessCode.verify(token);
    if (codeResult.ok) return codeResult;
    // Un jeton Firebase non-JWT ne peut pas être valide ; inutile d'appeler
    // le vérificateur Firebase. On garde la raison du code pour le journal.
    return codeResult;
  }
}

export type VerifierOptions =
  | { mode: 'code'; accessCode: string | null }
  | { mode: 'firebase'; firebase: AccessVerifier }
  | { mode: 'hybrid'; firebase: AccessVerifier; accessCode: string | null };

/** Construit le vérificateur correspondant à la configuration. */
export function createVerifier(options: VerifierOptions): AccessVerifier {
  switch (options.mode) {
    case 'code':
      return options.accessCode ? new AccessCodeVerifier(options.accessCode) : new OpenVerifier();
    case 'firebase':
      return options.firebase;
    case 'hybrid':
      return options.accessCode
        ? new HybridVerifier(options.firebase, new AccessCodeVerifier(options.accessCode))
        : options.firebase;
  }
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Middleware d'authentification.
 *
 * `/api/health` reste accessible sans vérification (API-CONTRACT.md §2).
 * Les deux justificatifs sont acceptés : un jeton Firebase peut cohabiter avec
 * le code partagé pendant la transition du frontend.
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

    const bearer = extractBearer(c.req.header('authorization'));
    const accessCode = c.req.header('x-access-code')?.trim() || null;

    let result: AuthResult | null = null;
    if (bearer) {
      result = await verifier.verify(bearer);
    }
    // Si le jeton Firebase échoue, le code partagé reste une solution de
    // secours en mode hybride (et en mode code, où le jeton n'est pas requis).
    if ((!result || !result.ok) && accessCode && accessCode !== bearer) {
      const codeResult = await verifier.verify(accessCode);
      if (codeResult.ok || !result) result = codeResult;
    }

    if (!result?.ok) {
      throw new AppError('unauthorized', undefined, result?.reason ?? 'missing_credentials');
    }

    c.set('identity', result.identity);
    await next();
  };
}
