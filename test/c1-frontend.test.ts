import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { testApp } from './helpers.js';
import { applyNonce } from '../src/middleware/csp.js';

const INDEX_PATH = resolve(process.cwd(), 'public', 'index.html');
const indexHtml = readFileSync(INDEX_PATH, 'utf8');

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

  it('n’ajoute pas deux fois le même nonce', () => {
    const html = applyNonce('<script nonce=" deja">y()</script>', 'abc');
    expect((html.match(/nonce=/g) ?? []).length).toBe(1);
  });
});
