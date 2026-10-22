import { describe, expect, it } from 'vitest';
import { alignNumbering, articles } from '../src/doc/structure.js';

const AVANT = `# Contrat de bail

## Article 1 – Objet du contrat

Le Bailleur donne à bail un studio.

## Article 2 – Durée

Le bail dure 12 mois.

## Article 3 – Charges

La Locataire prend en charge l'électricité.
`;

const APRES = `# Contrat de bail

## Article 1 – Objet du contrat

Le Bailleur donne à bail un studio.

## Article 2 – Clause personnalisée

Clause écrite à la main.

## Article 3 – Durée

Le bail dure 12 mois.

## Article 4 – Charges

La Locataire prend en charge l'électricité.
`;

describe('Alignement de la numérotation', () => {
  it('donne au document d’avant les numéros du document d’après', () => {
    const aligned = alignNumbering(AVANT, APRES);
    expect(articles(aligned).map((article) => article.title)).toEqual([
      'Article 1 – Objet du contrat',
      'Article 3 – Durée',
      'Article 4 – Charges',
    ]);
  });

  it('laisse intact un document sans déplacement', () => {
    expect(alignNumbering(AVANT, AVANT)).toBe(AVANT);
  });
});
