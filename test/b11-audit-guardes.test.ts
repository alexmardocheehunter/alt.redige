/**
 * Audit des garde-fous : tests de régression pour les sécurités.
 *
 * Ces tests vérifient que les garde-fous du chat (injection de prompt,
 * validation structurelle, sécurité, etc.) ne régressent pas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccessVerifier } from '../src/middleware/auth.js';
import { resetRateLimits } from '../src/middleware/rateLimit.js';
import { readJson, testApp } from './helpers.js';
import { applyNonce } from '../src/middleware/csp.js';

const INDEX_PATH = new URL('../public/index.html', import.meta.url);
const indexHtml = await import('node:fs/promises').then((fs) => fs.readFile(INDEX_PATH, 'utf8'));

describe('C1 — le frontend est installé et servi', () => {
  it('public/index.html est le fichier livré', () => {
    expect(indexHtml).toContain('alt.redige');
    expect(indexHtml.length).toBeGreaterThan(20_000);
  });

  it('GET / sert la page avec le bon type MIME', async () => {
    const app = testApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('alt.redige');
  });

  it('pose une Content-Security-Policy avec un nonce', async () => {
    const app = testApp();
    const res = await app.request('/');
    const policy = res.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toMatch(/script-src 'self' 'nonce-[^']+'/);
  });

  it('le nonce de la réponse autorise le script inline de la page', async () => {
    const app = testApp();
    const res = await app.request('/');
    const policy = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();

    const html = await res.text();
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/gi)];
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const [, attributes] of inlineScripts) {
      expect(attributes).toContain(`nonce="${nonce}"`);
    }
  });

  it('autorise la popup Google à rendre la session à la page', async () => {
    const app = testApp();
    const res = await app.request('/');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });

  it('donne un nonce différent à chaque réponse', async () => {
    const app = testApp();
    const first = await app.request('/');
    const second = await app.request('/');
    const nonceOf = (res: Response) => /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });

  it('ne touche pas les scripts externes', () => {
    const nonce = 'abc123';
    const html = applyNonce('<script src="/x.js"></script><script>y()</script>', nonce);
    expect(html).toContain('<script src="/x.js">');
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it('n\'ajoute pas deux fois le même nonce', () => {
    const html = applyNonce('<script nonce=" deja">y()</script>', 'abc');
    expect((html.match(/nonce=/g) ?? []).length).toBe(1);
  });
});

describe('S11 — Content-Security-Policy et Permissions-Policy', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('autorise l\'origine de l\'API dans connect-src (CSP)', async () => {
    const app = testApp({ publicApiBase: 'https://api.example.com' });
    const res = await app.request('/');
    expect(res.headers.get('content-security-policy'))
      .toContain("connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://api.example.com");
  });

  it('répond au préflight CORS depuis Firebase Hosting', async () => {
    const app = testApp({ allowedOrigins: ['https://altredige.web.app'] });
    const res = await app.request('/api/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://altredige.web.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://altredige.web.app');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-max-age')).toBe('600');
  });

  it('refuse le préflight CORS depuis une origine non listée', async () => {
    const app = testApp({ allowedOrigins: ['https://altredige.web.app'] });
    const res = await app.request('/api/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('Permissions-Policy : geolocation, camera, microphone désactivés', async () => {
    const app = testApp();
    const res = await app.request('/');
    const pp = res.headers.get('permissions-policy') ?? '';
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
  });
});