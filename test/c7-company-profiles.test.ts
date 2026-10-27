import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessVerifier } from '../src/middleware/auth.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { MemoryCompanyProfileStore } from './company-fake.js';
import { FakeOpenRouter, fakeClient, parseSse } from './fake-llm.js';
import { readJson, testApp } from './helpers.js';

const validBody = (legalName: string, isDefault?: boolean) => ({
  label: legalName,
  legal_name: legalName,
  legal_form: 'SARL',
  capital: '1 000 000 FCFA',
  rccm: 'CI-ABJ-2026-B-00000',
  tax_id: '0000000 A',
  address: 'Cocody, Rue des Jardins',
  city: 'Abidjan',
  postal_box: '01 BP 0000 Abidjan 01',
  representative_first_name: 'Awa',
  representative_last_name: 'Kone',
  representative_role: 'Gérante',
  phone: '+225 00 00 00 00 00',
  email: 'contact@exemple.ci',
  signature_place: 'Abidjan',
  logo: '',
  ...(isDefault === undefined ? {} : { is_default: isDefault }),
});

function verifier(): AccessVerifier {
  return {
    optional: false,
    kind: 'test_firebase',
    async verify(token: string | null) {
      if (token === 'token-a') return { ok: true, identity: 'uid-a' };
      if (token === 'token-b') return { ok: true, identity: 'uid-b' };
      return { ok: false, identity: null, reason: 'invalid_token' };
    },
  };
}

function companyApp(store = new MemoryCompanyProfileStore()) {
  return testApp(
    { authMode: 'firebase', firebaseProjectId: 'altredige' },
    { verifier: verifier(), companyProfileStore: store },
  );
}

function bearer(token = 'token-a'): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function put(
  app: ReturnType<typeof companyApp>,
  id: string,
  body: unknown = validBody('Exemple SARL'),
  token = 'token-a',
) {
  return app.request(`/api/company-profiles/${id}`, {
    method: 'PUT',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function list(app: ReturnType<typeof companyApp>, token = 'token-a') {
  return app.request('/api/company-profiles', { headers: bearer(token) });
}

beforeEach(() => {
  resetRateLimits();
});

describe('profils d’entreprise — accès et isolation', () => {
  it('refuse sans authentification', async () => {
    const res = await companyApp().request('/api/company-profiles');
    expect(res.status).toBe(401);
  });

  it('refuse une identité non individuelle (code partagé)', async () => {
    const shared: AccessVerifier = {
      optional: false,
      kind: 'code_only',
      async verify(token) {
        return token === 'secret'
          ? { ok: true, identity: null }
          : { ok: false, identity: null, reason: 'invalid' };
      },
    };
    const app = testApp(
      { authMode: 'code', accessCode: 'secret' },
      { verifier: shared, companyProfileStore: new MemoryCompanyProfileStore() },
    );
    const res = await app.request('/api/company-profiles', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(401);
  });

  it('isole les profils par uid, même avec le même identifiant', async () => {
    const store = new MemoryCompanyProfileStore();
    const app = companyApp(store);

    expect((await put(app, 'profil-a1', validBody('Alpha SARL'), 'token-a')).status).toBe(200);
    expect((await put(app, 'profil-a1', validBody('Beta SARL'), 'token-b')).status).toBe(200);

    const alpha = await readJson(await list(app, 'token-a'));
    const beta = await readJson(await list(app, 'token-b'));
    expect(alpha.items).toHaveLength(1);
    expect(beta.items).toHaveLength(1);
    expect(alpha.items[0].legal_name).toBe('Alpha SARL');
    expect(beta.items[0].legal_name).toBe('Beta SARL');

    // Modifier le profil de A ne touche pas celui de B.
    await put(app, 'profil-a1', validBody('Alpha modifiée'), 'token-a');
    const betaAgain = await readJson(await list(app, 'token-b'));
    expect(betaAgain.items[0].legal_name).toBe('Beta SARL');

    // La suppression totale de A laisse B intact.
    const deleted = await app.request('/api/company-profiles', {
      method: 'DELETE',
      headers: bearer('token-a'),
    });
    expect(deleted.status).toBe(204);
    expect((await readJson(await list(app, 'token-a'))).items).toEqual([]);
    expect((await readJson(await list(app, 'token-b'))).items).toHaveLength(1);
  });

  it('ne divulgue aucun contenu dans les en-têtes ni dans une réponse d’erreur', async () => {
    const store = new MemoryCompanyProfileStore();
    const app = companyApp(store);
    await put(app, 'profil-a1', validBody('Secret SARL'));
    store.failures.add('list');
    const res = await list(app);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('Secret SARL');
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('profils d’entreprise — CRUD et défaut', () => {
  it('crée, ordonne le profil par défaut et le remplace', async () => {
    const app = companyApp();
    const first = await put(app, 'profil-a1', validBody('Alpha SARL'));
    expect(first.status).toBe(200);
    const firstPayload = await readJson(first);
    expect(firstPayload.profile.is_default).toBe(true);
    expect(firstPayload.profile.id).toBe('profil-a1');
    expect(firstPayload.profile.created_at).toBeTruthy();

    const second = await put(app, 'profil-b2', validBody('Beta SARL', true));
    expect(second.status).toBe(200);
    const secondPayload = await readJson(second);
    expect(secondPayload.profile.is_default).toBe(true);

    const listed = await list(app);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const payload = await readJson(listed);
    expect(payload.items.map((item: any) => item.legal_name)).toEqual(['Beta SARL', 'Alpha SARL']);
    expect(payload.items[0].is_default).toBe(true);
    expect(payload.items[1].is_default).toBe(false);
  });

  it('conserve un profil par défaut quand on le décoche sans en désigner un autre', async () => {
    const app = companyApp();
    await put(app, 'profil-a1', validBody('Alpha SARL'));
    const res = await put(app, 'profil-a1', validBody('Alpha SARL', false));
    expect((await readJson(res)).profile.is_default).toBe(true);
  });

  it('supprime de façon idempotente et promeut un autre profil', async () => {
    const app = companyApp();
    await put(app, 'profil-a1', validBody('Alpha SARL'));
    await put(app, 'profil-b2', validBody('Beta SARL'));
    const del = await app.request('/api/company-profiles/profil-b2', {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(del.status).toBe(204);
    await expect(app.request('/api/company-profiles/profil-b2', {
      method: 'DELETE',
      headers: bearer(),
    })).resolves.toMatchObject({ status: 204 });

    const remaining = await readJson(await list(app));
    expect(remaining.items).toHaveLength(1);
    expect(remaining.items[0].legal_name).toBe('Alpha SARL');
    expect(remaining.items[0].is_default).toBe(true);
  });

  it('remplit les champs absents par des chaînes vides (PUT complet)', async () => {
    const app = companyApp();
    await put(app, 'profil-a1', validBody('Alpha SARL'));
    const res = await put(app, 'profil-a1', { legal_name: 'Alpha nouvelle' });
    const payload = await readJson(res);
    expect(payload.profile.legal_name).toBe('Alpha nouvelle');
    expect(payload.profile.address).toBe('');
    expect(payload.profile.phone).toBe('');
  });

  it('limite à cinq profils', async () => {
    const app = companyApp();
    for (let index = 1; index <= 5; index += 1) {
      const res = await put(app, `profil-${index}`, validBody(`Société ${index}`));
      expect(res.status).toBe(200);
    }
    const sixth = await put(app, 'profil-6', validBody('Société 6'));
    expect(sixth.status).toBe(400);
    expect((await readJson(sixth)).error.code).toBe('bad_request');
  });

  it('supprime tous les profils de l’utilisateur', async () => {
    const app = companyApp();
    await put(app, 'profil-a1', validBody('Alpha SARL'));
    const res = await app.request('/api/company-profiles', {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(res.status).toBe(204);
    expect((await readJson(await list(app))).items).toEqual([]);
  });
});

describe('profils d’entreprise — validation', () => {
  it('refuse un identifiant invalide', async () => {
    const app = companyApp();
    expect((await put(app, 'court', validBody('Alpha'))).status).toBe(400);
    expect((await put(app, 'profil avec espace', validBody('Alpha'))).status).toBe(400);
  });

  it('refuse un corps vide, non-objet ou sans valeur', async () => {
    const app = companyApp();
    expect((await put(app, 'profil-a1', {})).status).toBe(400);
    expect((await put(app, 'profil-a1', { legal_name: '   ' })).status).toBe(400);
    expect((await put(app, 'profil-a1', { legal_name: 42 })).status).toBe(400);
    expect((await put(app, 'profil-a1', { is_default: 'oui', legal_name: 'Alpha' })).status).toBe(400);
    const badJson = await app.request('/api/company-profiles/profil-a1', {
      method: 'PUT',
      headers: { ...bearer(), 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(badJson.status).toBe(400);
  });

  it('refuse un champ trop long et un logo non autorisé', async () => {
    const app = companyApp();
    const tooLong = await put(app, 'profil-a1', { legal_name: 'x'.repeat(201) });
    expect(tooLong.status).toBe(413);
    const badLogo = await put(app, 'profil-a1', {
      legal_name: 'Alpha',
      logo: 'data:image/svg+xml;base64,PHN2Zz4=',
    });
    expect(badLogo.status).toBe(400);
    const goodLogo = await put(app, 'profil-a1', {
      legal_name: 'Alpha',
      logo: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(goodLogo.status).toBe(200);
  });

  it('répond 503 quand le stockage est indisponible', async () => {
    const store = new MemoryCompanyProfileStore();
    const app = companyApp(store);
    store.failures.add('put');
    const res = await put(app, 'profil-a1', validBody('Alpha'));
    expect(res.status).toBe(503);
    expect((await readJson(res)).error.code).toBe('storage_unavailable');
  });
});

describe('profils d’entreprise — injection dans le chat', () => {
  function chatApp(store: MemoryCompanyProfileStore, fake: FakeOpenRouter) {
    return testApp(
      { authMode: 'firebase', firebaseProjectId: 'altredige' },
      { verifier: verifier(), companyProfileStore: store, client: fakeClient(fake) },
    );
  }

  function chat(app: ReturnType<typeof chatApp>, profileId?: string) {
    return app.request('/api/chat', {
      method: 'POST',
      headers: { ...bearer(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Bonjour.' }],
        ...(profileId ? { company_profile_id: profileId } : {}),
      }),
    });
  }

  it('injecte le profil sélectionné, sans celui d’un autre compte', async () => {
    const store = new MemoryCompanyProfileStore();
    await store.put('uid-a', 'profil-a1', validBody('Alpha SARL'));
    await store.put('uid-a', 'profil-b2', validBody('Beta SARL', true));
    await store.put('uid-b', 'profil-c3', validBody('Gamma SARL'));
    const fake = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }] });
    const app = chatApp(store, fake);

    const res = await chat(app, 'profil-a1');
    expect(res.status).toBe(200);
    await res.text();
    const system = String((fake.calls[0]!.messages as any[])[0].content);
    expect(system).toContain('Alpha SARL');
    expect(system).not.toContain('Beta SARL');
    expect(system).not.toContain('Gamma SARL');
    expect(system).toContain('Cocody, Rue des Jardins');
    expect(system).toContain('Awa Kone');
  });

  it('utilise le profil par défaut quand l’identifiant est absent ou inconnu', async () => {
    const store = new MemoryCompanyProfileStore();
    await store.put('uid-a', 'profil-a1', validBody('Alpha SARL'));
    await store.put('uid-a', 'profil-b2', validBody('Beta SARL', true));
    const fake = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }, { text: 'Bonjour.' }] });
    const app = chatApp(store, fake);

    await (await chat(app)).text();
    await (await chat(app, 'profil-inconnu')).text();
    const firstSystem = String((fake.calls[0]!.messages as any[])[0].content);
    const secondSystem = String((fake.calls[1]!.messages as any[])[0].content);
    expect(firstSystem).toContain('Beta SARL');
    expect(secondSystem).toContain('Beta SARL');
  });

  it('refuse un identifiant de profil mal formé', async () => {
    const store = new MemoryCompanyProfileStore();
    const fake = new FakeOpenRouter({ turns: [] });
    const app = chatApp(store, fake);
    const res = await chat(app, 'x');
    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('continue le chat si Firestore est indisponible', async () => {
    const store = new MemoryCompanyProfileStore();
    store.failures.add('getDefault');
    const fake = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }] });
    const app = chatApp(store, fake);
    const res = await chat(app);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(parseSse(body).some((event) => event.event === 'done')).toBe(true);
    const system = String((fake.calls[0]!.messages as any[])[0].content);
    expect(system).toContain('aucun profil d’entreprise enregistré');
  });
});
