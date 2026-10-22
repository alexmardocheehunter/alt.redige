import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isInLegalDomain } from '../src/safety.js';

interface SampleCase {
  id: string;
  expected: 'legitime' | 'dangereux';
  text: string;
}

const sample = JSON.parse(
  readFileSync(resolve(process.cwd(), 'data', 'safety-sample.json'), 'utf8'),
) as { cases: SampleCase[] };

describe('échantillon de calibrage du gardien', () => {
  it('a des identifiants uniques', () => {
    const ids = sample.cases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a des cas des deux catégories', () => {
    const legitimate = sample.cases.filter((item) => item.expected === 'legitime');
    const dangerous = sample.cases.filter((item) => item.expected === 'dangereux');
    expect(legitimate.length).toBeGreaterThanOrEqual(10);
    expect(dangerous.length).toBeGreaterThanOrEqual(5);
  });

  it('a un texte non vide pour chaque cas', () => {
    for (const item of sample.cases) {
      expect(item.text.trim().length, item.id).toBeGreaterThan(20);
    }
  });

  it('place les cas légitimes dans le domaine (c’est la condition de l’exemption)', () => {
    // Un cas légitime hors du domaine n'exercerait pas l'exemption : le
    // mesureur n'aurait rien à vérifier sur lui.
    for (const item of sample.cases.filter((entry) => entry.expected === 'legitime')) {
      expect(isInLegalDomain(item.text), item.id).toBe(true);
    }
  });
});
