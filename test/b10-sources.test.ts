import { describe, expect, it } from 'vitest';
import { loadLegalSources, sourcesForTemplate, unverifiedSourcesForTemplate, isForeignSource } from '../src/legal-sources.js';
import { TemplateStore } from '../src/templates.js';

const sources = loadLegalSources();
const store = TemplateStore.load();

describe('B5 — référentiel juridique unique', () => {
  it('chaque source a un pays et un indicateur « à vérifier »', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const source of sources) {
      expect(source.code).toBeTruthy();
      expect(source.title.length).toBeGreaterThan(5);
      expect(source.country.length).toBeGreaterThan(2);
      expect(typeof source.to_verify).toBe('boolean');
      expect(['integrated', 'partial', 'to_verify', 'not_found']).toContain(source.status);
      expect(source.kind).toBe('law');
    }
  });

  it('les codes sont uniques', () => {
    const codes = sources.map((source) => source.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('contient les sources attendues', () => {
    const titles = sources.map((source) => source.title).join(' | ');
    expect(titles).toMatch(/Code du travail/);
    expect(titles).toMatch(/Code général des impôts/);
    expect(titles).toMatch(/Code civil/);
    expect(titles).toMatch(/droit commercial général/);
    expect(titles).toMatch(/sécurité privée/);
    expect(titles).toMatch(/hygiène/);
    expect(titles).toMatch(/stages/);
    expect(titles).toMatch(/77-995/);
  });

  it('distingue les textes ivoiriens des textes communautaires', () => {
    const ohada = sources.find((source) => source.code === 'S11')!;
    expect(isForeignSource(ohada)).toBe(true);
    expect(ohada.country).toMatch(/UEMOA/);

    const travail = sources.find((source) => source.code === 'S01')!;
    expect(isForeignSource(travail)).toBe(false);
  });

  it('remonte les sources citées par un modèle', () => {
    const bail = store.get('bail-habitation')!;
    const cited = sourcesForTemplate(bail);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.map((source) => source.ref)).toContain('S02');
  });

  it('signale les sources citées mais non vérifiées', () => {
    const professionnel = store.get('bail-professionnel')!;
    const unverified = unverifiedSourcesForTemplate(professionnel);
    // L'Acte Uniforme OHADA n'est pas dans le corpus : il doit être signalé.
    expect(unverified.map((source) => source.code)).toContain('S11');
  });

  it('chaque modèle cite des sources connues de la table', () => {
    const codes = new Set(sources.map((source) => source.code));
    for (const template of store.all()) {
      for (const note of template.legal_notes) {
        for (const match of note.matchAll(/\[(S\d{2})/g)) {
          expect(codes.has(match[1]!)).toBe(true);
        }
      }
    }
  });
});
