import { describe, expect, it } from 'vitest';
import { articles, renumberArticles, brokenReferences, normalizeKey } from '../src/doc/structure.js';

const AVANT = `# Contrat de bail

## Article 1 – Objet du contrat

Le Bailleur donne à bail.

Conformément à l'article 3, le preneur restitue les lieux.

## Article 2 – Durée

Le bail dure 12 mois.

## Article 3 – Résiliation

Chaque partie peut résilier.

## Article 4 – Signatures

Fait à Abidjan.
`;

describe('A3 — numérotation des articles', () => {
  it('liste les articles avec leur numéro et leur intitulé', () => {
    const list = articles(AVANT);
    expect(list).toHaveLength(4);
    expect(list[0]!.number).toBe(1);
    expect(list[0]!.label).toBe('Objet du contrat');
    expect(list[3]!.label).toBe('Signatures');
  });

  it('renumérote à la suite et corrige les renvois internes', () => {
    // L'article 2 est supprimé : les suivants remontent d'un cran.
    const apres = AVANT
      .replace('## Article 2 – Durée\n\nLe bail dure 12 mois.\n\n', '')
      .replace('## Article 3 – Résiliation', '## Article 9 – Résiliation');

    const result = renumberArticles(AVANT, apres);
    const list = articles(result.markdown);

    expect(list.map((a) => a.number)).toEqual([1, 2, 3]);
    expect(list[1]!.label).toBe('Résiliation');
    expect(list[2]!.label).toBe('Signatures');
    // Le renvoi « conformément à l'article 3 » pointait sur la résiliation,
    // devenue l'article 2 : il doit suivre.
    expect(result.markdown).toContain("Conformément à l'article 2");
    expect(result.markdown).not.toContain("Conformément à l'article 3");
    expect(result.changed).toBe(true);
  });

  it('laisse les numéros valides inchangés', () => {
    const result = renumberArticles(AVANT, AVANT);
    expect(result.markdown).toBe(AVANT);
    expect(result.changed).toBe(false);
  });

  it('ne touche pas aux renvois vers un article inexistant', () => {
    const apres = AVANT.replace("Conformément à l'article 3", "Conformément à l'article 9");
    const result = renumberArticles(AVANT, apres);
    expect(result.markdown).toContain("Conformément à l'article 9");
  });

  it('détecte un renvoi cassé', () => {
    const cassee = AVANT.replace("Conformément à l'article 3", "Conformément à l'article 12");
    expect(brokenReferences(cassee)).toEqual([12]);
    expect(brokenReferences(AVANT)).toEqual([]);
  });

  it('ne confond pas deux articles de même intitulé', () => {
    const avant = '## Article 1 – Objet\n\nx\n\n## Article 2 – Objet\n\ny\n';
    const apres = '## Article 1 – Objet\n\nx\n';
    const result = renumberArticles(avant, apres);
    expect(articles(result.markdown)).toHaveLength(1);
    expect(normalizeKey('Objet')).toBe('objet');
  });
});
