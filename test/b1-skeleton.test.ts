import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson, testApp } from './helpers.js';
describe('B1 — squelette', () => {
  it('GET /api/health répond 200 avec le contrat et le modèle', async () => {
    const app = testApp({ model: 'minimax/minimax-m3.1-flash:free' });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toEqual({
      ok: true,
      contract_version: '1.0',
      model: 'minimax/minimax-m3.1-flash:free',
    });
  });

  it('GET /api/health ne demande pas le code d’accès', async () => {
    const app = testApp({ accessCode: 'secret' });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
  });

  it('GET / sert la page en HTML UTF-8', async () => {
    const app = testApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('GET / sert le fichier public/index.html, seul le nonce de la CSP étant ajouté', async () => {
    const app = testApp();
    const res = await app.request('/');
    const served = Buffer.from(await res.arrayBuffer()).toString('utf8');
    const onDisk = readFileSync(resolve(process.cwd(), 'public', 'index.html'), 'utf8');

    // Le fichier livré n'est jamais modifié sur le disque : le serveur ajoute
    // seulement l'attribut `nonce` qui autorise le script inline de la page.
    const withoutNonce = served.replace(/ nonce="[^"]*"/g, '');
    expect(withoutNonce).toBe(onDisk);
  });

  it('pose les en-têtes de sécurité', async () => {
    const app = testApp();
    const res = await app.request('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('renvoie un identifiant de requête', async () => {
    const app = testApp();
    const res = await app.request('/api/health');
    expect(res.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{16}$/);
  });

  it('refuse une route /api/* inconnue avec une erreur JSON', async () => {
    const app = testApp();
    const res = await app.request('/api/inconnu');
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.code).toBe('bad_request');
  });
});

describe('B1 — authentification par code d’accès', () => {
  it('répond 401 sans code quand ACCESS_CODE est défini', async () => {
    const app = testApp({ accessCode: 'secret' });
    const res = await app.request('/api/something');
    expect(res.status).toBe(401);
    const body = await readJson(res);
    expect(body.error.code).toBe('unauthorized');
  });

  it('accepte le bon code', async () => {
    const app = testApp({ accessCode: 'secret' });
    const res = await app.request('/api/health', { headers: { 'X-Access-Code': 'secret' } });
    expect(res.status).toBe(200);
  });

  it('refuse un mauvais code', async () => {
    const app = testApp({ accessCode: 'secret' });
    const res = await app.request('/api/something', { headers: { 'X-Access-Code': 'mauvais' } });
    expect(res.status).toBe(401);
  });
});

describe('B1 — limites de corps de requête', () => {
  it('renvoie 413 au-delà de la limite', async () => {
    const app = testApp({ maxBodyBytes: 1024 });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(4096) }),
    });
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.error.code).toBe('payload_too_large');
  });
});
