import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessVerifier } from '../src/middleware/auth.js';
import type {
  HistoryInput,
  HistoryRecord,
  HistoryStore,
  HistorySummary,
} from '../src/history/store.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { readJson, testApp } from './helpers.js';

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryHistoryStore implements HistoryStore {
  private readonly docs = new Map<string, Map<string, HistoryRecord>>();
  private clock = 0;

  private now(): string {
    this.clock += 1;
    return new Date(BASE_TIME + this.clock * 1000).toISOString();
  }

  private userDocs(uid: string): Map<string, HistoryRecord> {
    let docs = this.docs.get(uid);
    if (!docs) {
      docs = new Map();
      this.docs.set(uid, docs);
    }
    return docs;
  }

  async list(uid: string, limit: number): Promise<HistorySummary[]> {
    return [...this.userDocs(uid).values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit)
      .map(({ id, title, contract_type, version, created_at, updated_at }) => ({
        id, title, contract_type, version, created_at, updated_at,
      }));
  }

  async get(uid: string, id: string): Promise<HistoryRecord | null> {
    const record = this.userDocs(uid).get(id);
    return record ? clone(record) : null;
  }

  async put(uid: string, id: string, input: HistoryInput): Promise<HistoryRecord> {
    const previous = this.userDocs(uid).get(id);
    const timestamp = this.now();
    const record: HistoryRecord = {
      id,
      ...clone(input),
      created_at: previous?.created_at ?? timestamp,
      updated_at: timestamp,
    };
    this.userDocs(uid).set(id, record);
    return clone(record);
  }

  async delete(uid: string, id: string): Promise<void> {
    this.userDocs(uid).delete(id);
  }
}

function testVerifier(): AccessVerifier {
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

const validBody = {
  title: 'Bail d’habitation',
  contract_type: 'bail-habitation',
  markdown: '# Bail\n\nLe présent contrat…',
  version: 3,
  messages: [
    { role: 'user', content: 'Rédige un bail.' },
    { role: 'assistant', content: 'Voici le bail.' },
  ],
};

function historyApp(overrides: Record<string, unknown> = {}, store = new MemoryHistoryStore()) {
  return testApp(
    {
      authMode: 'firebase',
      firebaseProjectId: 'altredige',
      historyEnabled: true,
      ...overrides,
    },
    { verifier: testVerifier(), historyStore: store },
  );
}

function bearer(token = 'token-a'): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function put(app: ReturnType<typeof historyApp>, id: string, body: unknown = validBody, token = 'token-a') {
  return app.request(`/api/history/${id}`, {
    method: 'PUT',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimits();
});

describe('historiques — accès', () => {
  it('refuse sans authentification', async () => {
    const res = await historyApp().request('/api/history');
    expect(res.status).toBe(401);
  });

  it('refuse une identité non individuelle (code partagé)', async () => {
    const verifier: AccessVerifier = {
      optional: false,
      kind: 'code_only',
      async verify(token) {
        return token === 'secret'
          ? { ok: true, identity: null }
          : { ok: false, identity: null, reason: 'invalid' };
      },
    };
    const app = testApp(
      {
        authMode: 'hybrid',
        accessCode: 'secret',
        firebaseProjectId: 'altredige',
        historyEnabled: true,
      },
      { verifier, historyStore: new MemoryHistoryStore() },
    );
    const res = await app.request('/api/history', { headers: { 'X-Access-Code': 'secret' } });
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.message).toContain('Google');
  });

  it('isole les historiques de deux utilisateurs', async () => {
    const store = new MemoryHistoryStore();
    const app = historyApp({}, store);
    expect((await put(app, 'abcdefgh')).status).toBe(200);

    const other = await app.request('/api/history/abcdefgh', { headers: bearer('token-b') });
    expect(other.status).toBe(404);
    const listB = await app.request('/api/history', { headers: bearer('token-b') });
    expect((await readJson(listB)).items).toEqual([]);
  });
});

describe('historiques — cycle de vie', () => {
  it('crée, lit, liste, met à jour et supprime', async () => {
    const app = historyApp();

    const created = await put(app, 'abcdefgh');
    expect(created.status).toBe(200);
    const createdBody = await readJson(created);
    expect(createdBody.id).toBe('abcdefgh');
    expect(typeof createdBody.updated_at).toBe('string');

    const read = await app.request('/api/history/abcdefgh', { headers: bearer() });
    expect(read.status).toBe(200);
    const record = await readJson(read);
    expect(record.title).toBe(validBody.title);
    expect(record.markdown).toBe(validBody.markdown);
    expect(record.messages).toEqual(validBody.messages);
    expect(record.created_at).toBe(createdBody.updated_at);

    const list = await app.request('/api/history', { headers: bearer() });
    const items = (await readJson(list)).items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('abcdefgh');
    expect(items[0]).not.toHaveProperty('markdown');

    const updated = await put(app, 'abcdefgh', { ...validBody, title: 'Bail modifié', version: 4 });
    expect(updated.status).toBe(200);
    const readUpdated = await readJson(await app.request('/api/history/abcdefgh', { headers: bearer() }));
    expect(readUpdated.title).toBe('Bail modifié');
    expect(readUpdated.version).toBe(4);
    expect(readUpdated.created_at).toBe(record.created_at);

    const deleted = await app.request('/api/history/abcdefgh', { method: 'DELETE', headers: bearer() });
    expect(deleted.status).toBe(204);

    const missing = await app.request('/api/history/abcdefgh', { headers: bearer() });
    expect(missing.status).toBe(404);
    const missingBody = await readJson(missing);
    expect(missingBody.error.code).toBe('not_found');

    // Suppression idempotente.
    const again = await app.request('/api/history/abcdefgh', { method: 'DELETE', headers: bearer() });
    expect(again.status).toBe(204);
  });

  it('refuse un identifiant invalide', async () => {
    const app = historyApp();
    expect((await app.request('/api/history/short', { headers: bearer() })).status).toBe(400);
    expect((await put(app, 'bad.id')).status).toBe(400);
  });
});

describe('historiques — validation', () => {
  it('refuse un corps non objet', async () => {
    const res = await put(historyApp(), 'abcdefgh', null);
    expect(res.status).toBe(400);
  });

  it('refuse un titre vide ou trop long', async () => {
    const app = historyApp();
    expect((await put(app, 'abcdefgh', { ...validBody, title: '   ' })).status).toBe(400);
    expect((await put(app, 'abcdefgh', { ...validBody, title: 'a'.repeat(201) })).status).toBe(400);
  });

  it('refuse une version invalide', async () => {
    const app = historyApp();
    expect((await put(app, 'abcdefgh', { ...validBody, version: 0 })).status).toBe(400);
    expect((await put(app, 'abcdefgh', { ...validBody, version: 1.5 })).status).toBe(400);
  });

  it('refuse plus de 30 messages', async () => {
    const messages = Array.from({ length: 31 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'message',
    }));
    const res = await put(historyApp(), 'abcdefgh', { ...validBody, messages });
    expect(res.status).toBe(400);
  });

  it('refuse des rôles qui ne s’alternent pas', async () => {
    const res = await put(historyApp(), 'abcdefgh', {
      ...validBody,
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('refuse un document de plus de 200 Ko', async () => {
    const res = await put(historyApp(), 'abcdefgh', { ...validBody, markdown: 'a'.repeat(200_001) });
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.error.code).toBe('payload_too_large');
  });

  it('refuse un message de plus de 8 000 caractères', async () => {
    const res = await put(historyApp(), 'abcdefgh', {
      ...validBody,
      messages: [{ role: 'user', content: 'a'.repeat(8001) }],
    });
    expect(res.status).toBe(413);
  });
});

describe('historiques — limites et pannes', () => {
  it('limite le débit par identité', async () => {
    const app = historyApp({ rateHistoryPerMin: 1 });
    expect((await app.request('/api/history', { headers: bearer('token-a') })).status).toBe(200);
    expect((await app.request('/api/history', { headers: bearer('token-a') })).status).toBe(429);
    // Un autre utilisateur conserve son propre quota.
    expect((await app.request('/api/history', { headers: bearer('token-b') })).status).toBe(200);
  });

  it('traduit une panne Firestore en 503 storage_unavailable', async () => {
    const failing: HistoryStore = {
      async list() { throw new Error('firestore down'); },
      async get() { throw new Error('firestore down'); },
      async put() { throw new Error('firestore down'); },
      async delete() { throw new Error('firestore down'); },
    };
    const app = testApp(
      { authMode: 'firebase', firebaseProjectId: 'altredige', historyEnabled: true },
      { verifier: testVerifier(), historyStore: failing },
    );
    const res = await app.request('/api/history', { headers: bearer() });
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(body.error.code).toBe('storage_unavailable');
  });
});
