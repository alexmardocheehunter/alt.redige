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
  it('ne charge que le SDK Firebase comme ressource externe', () => {
    const external = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]!);
    expect(external).toEqual([
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
    ]);
    expect(html).not.toContain('cdnjs');
    // Aucune autre origine externe : les exports Word/PDF passent par l'API.
    const remote = [...html.matchAll(/\b(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]!);
    expect(remote.every((url) => url.startsWith('https://www.gstatic.com/firebasejs/'))).toBe(true);
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
    expect(source).toContain('signInWithPopup');
    expect(source).toContain('Authorization');
    expect(source).toContain("'Bearer '");
    expect(source).toContain('X-Request-Id');
    expect(source).not.toContain('X-Access-Code');
  });

  it('les erreurs sont traduites en français', () => {
    expect(source).toContain('Le service de rédaction est momentanément indisponible');
    expect(source).toContain('Trop de demandes');
  });

  it('gère les événements et champs ajoutés au contrat', () => {
    // `clause_explained` : l'explication d'une clause.
    expect(source).toContain("case 'clause_explained':");
    expect(source).toContain('renderClause');
    // `canvas_set.validation.fields` : les champs obligatoires restants.
    expect(source).toContain('data.validation && data.validation.fields');
    expect(source).toContain('renderFields');
    // `canvas_set.legal_notice` : l'avertissement de revalidation.
    expect(source).toContain('data.legal_notice');
    expect(source).toContain('renderLegalNotice');
  });

  it('affiche la carte de question, pas seulement son texte', () => {
    expect(source).toContain('function questionCard');
    expect(source).toContain('.qcard');
  });
});
