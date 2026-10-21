import { afterEach, describe, expect, it } from 'vitest';
import { readJson, testApp } from './helpers.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { runtimeState } from '../src/runtime-state.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';
import { SAMPLE_BAIL } from './fixtures.js';

/** Application with a scripted model: no network call. */
function appWithFake(overrides = {}) {
  const client = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }] });
  return testApp(overrides, { client: fakeClient(client) });
}

afterEach(() => {
  resetRateLimits();
  runtimeState.shuttingDown = false;
});

describe('B7 — limitation de débit', () => {
  it('refuse les requêtes au-delà de la limite et renvoie Retry-After', async () => {
    const app = appWithFake({ rateChatPerHour: 2 });
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }] });

    for (let index = 0; index < 2; index += 1) {
      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(200);
      await res.text();
    }

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const payload = await readJson(res);
    expect(payload.error.code).toBe('rate_limited');
    expect(payload.error.message).toBe('Trop de demandes. Réessayez dans quelques instants.');
  });

  it('applique une limite distincte à l’export', async () => {
    const app = testApp({ rateExportPerMin: 1 });
    const body = JSON.stringify({ markdown: SAMPLE_BAIL });

    const first = await app.request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    const second = await app.request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(second.status).toBe(429);
  });

  it('ne confond pas les quotas du chat et de l’export', async () => {
    const app = appWithFake({ rateChatPerHour: 1, rateExportPerMin: 1 });
    const exportRes = await app.request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: SAMPLE_BAIL }),
    });
    expect(exportRes.status).toBe(200);
    await exportRes.arrayBuffer();

    const chatRes = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }] }),
    });
    expect(chatRes.status).toBe(200);
  });
});

describe('B7 — arrêt propre', () => {
  it('refuse les nouveaux flux pendant l’arrêt', async () => {
    const app = appWithFake();
    runtimeState.shuttingDown = true;

    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }] }),
    });
    expect(res.status).toBe(503);
    const body = await readJson(res);
    expect(body.error.code).toBe('llm_unavailable');
  });

  it('laisse passer la vérification de santé', async () => {
    const app = appWithFake();
    runtimeState.shuttingDown = true;
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('B7 — messages d’erreur en français', () => {
  it('n’expose aucun détail technique', async () => {
    const app = appWithFake();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message).not.toMatch(/stack|at |node_modules|\.ts:\d+/i);
  });
});
