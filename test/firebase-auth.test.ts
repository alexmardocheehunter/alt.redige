import { describe, expect, it } from 'vitest';
import type { AccessVerifier, AuthResult } from '../src/middleware/auth.js';
import {
  AccessCodeVerifier,
  createVerifier,
  FirebaseTokenVerifier,
  HybridVerifier,
  OpenVerifier,
} from '../src/middleware/auth.js';
import { readJson, testApp } from './helpers.js';

function firebaseVerifier(token: string): FirebaseTokenVerifier {
  return new FirebaseTokenVerifier(async (candidate) => {
    if (candidate === token) return { uid: 'google-123' };
    const error = new Error('invalid') as Error & { code: string };
    error.code = 'auth/id-token-expired';
    throw error;
  });
}

function codeVerifier(code: string, identity: string | null = null): AccessVerifier {
  return {
    optional: false,
    kind: 'fake_code',
    async verify(token: string | null): Promise<AuthResult> {
      return token === code ? { ok: true, identity } : { ok: false, identity: null, reason: 'invalid' };
    },
  };
}

describe('FirebaseTokenVerifier', () => {
  it('accepte un jeton valide et retourne l’uid', async () => {
    const result = await firebaseVerifier('valid').verify('valid');
    expect(result).toEqual({ ok: true, identity: 'google-123' });
  });

  it('refuse un jeton invalide sans exposer de détail au client', async () => {
    const result = await firebaseVerifier('valid').verify('invalid');
    expect(result.ok).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.reason).toBe('auth/id-token-expired');
  });

  it('refuse l’absence de jeton', async () => {
    const result = await firebaseVerifier('valid').verify(null);
    expect(result).toEqual({ ok: false, identity: null, reason: 'missing_token' });
  });
});

describe('HybridVerifier', () => {
  const jwt = 'aaa.bbb.ccc';
  const invalidJwt = 'xxx.yyy.zzz';

  it('privilégie le jeton Firebase valide (identité = uid)', async () => {
    const verifier = new HybridVerifier(firebaseVerifier(jwt), codeVerifier('code'));
    await expect(verifier.verify(jwt)).resolves.toEqual({ ok: true, identity: 'google-123' });
  });

  it('accepte le code partagé en secours (identité nulle)', async () => {
    const verifier = new HybridVerifier(firebaseVerifier(jwt), codeVerifier('code'));
    await expect(verifier.verify('code')).resolves.toEqual({ ok: true, identity: null });
  });

  it('refuse un jeton invalide quand le code ne correspond pas', async () => {
    const verifier = new HybridVerifier(firebaseVerifier(jwt), codeVerifier('code'));
    const result = await verifier.verify(invalidJwt);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth/id-token-expired');
  });
});

describe('createVerifier', () => {
  it('conserve le mode code historique', () => {
    expect(createVerifier({ mode: 'code', accessCode: null })).toBeInstanceOf(OpenVerifier);
    expect(createVerifier({ mode: 'code', accessCode: 'secret' })).toBeInstanceOf(AccessCodeVerifier);
  });

  it('hybride sans code = vérificateur Firebase seul', () => {
    expect(createVerifier({
      mode: 'hybrid',
      firebase: firebaseVerifier('valid'),
      accessCode: null,
    })).toBeInstanceOf(FirebaseTokenVerifier);
  });

  it('hybride avec code = HybridVerifier', () => {
    expect(createVerifier({
      mode: 'hybrid',
      firebase: firebaseVerifier('valid'),
      accessCode: 'secret',
    })).toBeInstanceOf(HybridVerifier);
  });
});

describe('middleware d’authentification', () => {
  it('laisse /api/health public en mode firebase', async () => {
    const app = testApp(
      { authMode: 'firebase', firebaseProjectId: 'altredige' },
      { verifier: firebaseVerifier('valid') },
    );
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('refuse /api/templates sans jeton en mode firebase', async () => {
    const app = testApp(
      { authMode: 'firebase', firebaseProjectId: 'altredige' },
      { verifier: firebaseVerifier('valid') },
    );
    const res = await app.request('/api/templates');
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('accepte un jeton Bearer valide', async () => {
    const app = testApp(
      { authMode: 'firebase', firebaseProjectId: 'altredige' },
      { verifier: firebaseVerifier('valid') },
    );
    const res = await app.request('/api/templates', {
      headers: { Authorization: 'Bearer valid' },
    });
    expect(res.status).toBe(200);
  });

  it('accepte le code partagé en mode hybride', async () => {
    const app = testApp(
      { authMode: 'hybrid', accessCode: 'secret', firebaseProjectId: 'altredige' },
      { verifier: new HybridVerifier(firebaseVerifier('valid'), codeVerifier('secret')) },
    );
    const res = await app.request('/api/templates', {
      headers: { 'X-Access-Code': 'secret' },
    });
    expect(res.status).toBe(200);
  });

  it('utilise le code en secours quand le jeton Firebase est invalide', async () => {
    const app = testApp(
      { authMode: 'hybrid', accessCode: 'secret', firebaseProjectId: 'altredige' },
      { verifier: new HybridVerifier(firebaseVerifier('valid'), codeVerifier('secret')) },
    );
    const res = await app.request('/api/templates', {
      headers: {
        Authorization: 'Bearer expired',
        'X-Access-Code': 'secret',
      },
    });
    expect(res.status).toBe(200);
  });
});
