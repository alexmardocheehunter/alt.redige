import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INDEX = resolve(process.cwd(), 'public', 'index.html');
const SOURCE = resolve(process.cwd(), 'public', 'app-api.js');
const INJECT = resolve(process.cwd(), 'scripts', 'inject-app-api.mjs');

const html = readFileSync(INDEX, 'utf8');
const source = readFileSync(SOURCE, 'utf8');

describe('C5 — le frontend est branché sur l’API', () => {
  it('n’a plus aucun script externe', () => {
    const external = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]!);
    expect(external).toEqual([]);
    expect(html).not.toContain('cdnjs');
    // Aucun appel à une origine externe (le namespace SVG du prototype est
    // une URL de namespace, pas une ressource chargée).
    const remote = [...html.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]!);
    expect(remote).toEqual([]);
  });

  it('reste un fichier unique : le branchement est intégré dans la page', () => {
    expect(html).toContain('<!-- app-api:debut -->');
    expect(html).toContain('<!-- app-api:fin -->');
    expect(html).toContain('/api/chat');
    expect(html).toContain('/api/export/docx');
    expect(html).toContain('/api/templates');
  });

  it('le bloc intégré est à jour avec le fichier source', () => {
    const start = html.indexOf('<!-- app-api:debut -->');
    const end = html.indexOf('<!-- app-api:fin -->');
    const block = html.slice(start, end);
    // Le code injecté est le fichier source, à un retour à la ligne près.
    expect(block.replace(/\r\n/g, '\n')).toContain(source.replace(/\r\n/g, '\n').trim());
  });

  it('l’injection est idempotente', () => {
    const before = readFileSync(INDEX, 'utf8');
    execFileSync(process.execPath, [INJECT], { cwd: process.cwd() });
    expect(readFileSync(INDEX, 'utf8')).toBe(before);
  });

  it('le script source ne contient pas de balise de fermeture', () => {
    expect(source).not.toContain('</script>');
  });

  it('le garde-fou d’accès est transmis', () => {
    expect(source).toContain('X-Access-Code');
    expect(source).toContain('X-Request-Id');
  });

  it('les erreurs sont traduites en français', () => {
    expect(source).toContain('Le service de rédaction est momentanément indisponible');
    expect(source).toContain('Trop de demandes');
  });
});
