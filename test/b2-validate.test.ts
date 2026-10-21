import { describe, expect, it } from 'vitest';
import { validate, countPlaceholders, normalizeText, articleTitles } from '../src/doc/validate.js';
import { SAMPLE_BAIL, SAMPLE_BAIL_TEMPLATE } from './fixtures.js';
import type { ContractTemplate } from '../src/templates.js';

const template = JSON.parse(SAMPLE_BAIL_TEMPLATE) as ContractTemplate;

describe('validate — exemple de référence', () => {
  it('trouve 8 espaces réservés et aucune issue', () => {
    const result = validate(SAMPLE_BAIL);
    expect(result.placeholders).toBe(8);
    expect(result.issues).toEqual([]);
  });

  it('ne signale aucune issue avec le modèle de bail fourni', () => {
    const result = validate(SAMPLE_BAIL, template);
    expect(result.placeholders).toBe(8);
    expect(result.issues).toEqual([]);
  });

  it('compte les placeholders du squelette du modèle', () => {
    const result = validate(template.skeleton_markdown, template);
    expect(result.placeholders).toBeGreaterThan(0);
    expect(result.issues.filter((i) => i.code === 'missing_article')).toEqual([]);
  });
});

describe('validate — sous-ensemble interdit', () => {
  it('signale un titre de niveau 4', () => {
    const result = validate('# Titre\n\n#### Sous-titre\n');
    expect(result.issues.map((i) => i.code)).toContain('forbidden_construct');
  });

  it('signale une image', () => {
    const result = validate('# Titre\n\n![photo](image.png)\n');
    expect(result.issues.map((i) => i.code)).toContain('forbidden_construct');
  });

  it('signale un lien', () => {
    const result = validate('# Titre\n\n[texte](https://example.com)\n');
    expect(result.issues.map((i) => i.code)).toContain('forbidden_construct');
  });

  it('signale un bloc de code', () => {
    const result = validate('# Titre\n\n```js\nconst a = 1;\n```\n');
    expect(result.issues.map((i) => i.code)).toContain('forbidden_construct');
  });

  it('signale du HTML autre que le saut de page', () => {
    const result = validate('# Titre\n\n<div>texte</div>\n');
    expect(result.issues.map((i) => i.code)).toContain('forbidden_construct');
  });

  it('accepte le saut de page', () => {
    const result = validate('# Titre\n\n<!-- pagebreak -->\n');
    expect(result.issues).toEqual([]);
  });

  it('signale un titre manquant', () => {
    const result = validate('## Article 1 – Objet\n');
    expect(result.issues.map((i) => i.code)).toContain('missing_title');
  });

  it('signale plusieurs titres', () => {
    const result = validate('# Titre A\n\n# Titre B\n');
    expect(result.issues.map((i) => i.code)).toContain('multiple_titles');
  });

  it('signale un espace réservé non fermé', () => {
    const result = validate('# Titre\n\n[À COMPLÉTER : nom\n');
    expect(result.issues.map((i) => i.code)).toContain('placeholder_format');
    expect(result.placeholders).toBe(0);
  });

  it('signale un article obligatoire manquant', () => {
    const result = validate('# Titre\n\n## Article 1 – Objet\n', template);
    const missing = result.issues.filter((i) => i.code === 'missing_article');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.map((i) => i.message)).toContain('Article « Durée » absent.');
  });

  it('ignore la casse et les accents pour les articles', () => {
    const markdown = [
      '# Titre',
      '',
      '## Article 1 – OBJET du contrat',
      '',
      '## Article 2 – duree et Loyer',
      '',
      '## Article 3 – Obligations du Locataire',
      '',
      '## Article 4 – Résiliation',
      '',
      '## Article 5 – Signatures',
      '',
    ].join('\n');
    const result = validate(markdown, template);
    expect(result.issues.filter((i) => i.code === 'missing_article')).toEqual([]);
  });
});

describe('validate — utilitaires', () => {
  it('countPlaceholders compte les occurrences', () => {
    expect(countPlaceholders(SAMPLE_BAIL)).toBe(8);
    expect(countPlaceholders('')).toBe(0);
  });

  it('normalizeText retire les accents et met en minuscules', () => {
    expect(normalizeText('Résiliation')).toBe('resiliation');
  });

  it('articleTitles extrait les articles', () => {
    expect(articleTitles(SAMPLE_BAIL)).toHaveLength(5);
    expect(articleTitles(SAMPLE_BAIL)[0]).toBe('Article 1 – Objet du contrat');
  });
});
