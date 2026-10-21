import { describe, expect, it } from 'vitest';
import { validate, countPlaceholders, normalizeText, articleTitles } from '../src/doc/validate.js';
import { SAMPLE_BAIL, SAMPLE_BAIL_TEMPLATE } from './fixtures.js';
import { TemplateStore, type ContractTemplate } from '../src/templates.js';

const template = JSON.parse(SAMPLE_BAIL_TEMPLATE) as ContractTemplate;
/** Le modèle de bail réellement livré (référentiel juridique joint). */
const currentTemplate = TemplateStore.load().get('bail-habitation')!;

describe('validate — exemple de référence', () => {
  it('trouve 8 espaces réservés', () => {
    const result = validate(SAMPLE_BAIL);
    expect(result.placeholders).toBe(8);
  });

  it('ne signale aucune construction interdite', () => {
    const result = validate(SAMPLE_BAIL);
    expect(result.issues.filter((issue) => issue.code === 'forbidden_construct')).toEqual([]);
    expect(result.issues.filter((issue) => issue.code === 'missing_title')).toEqual([]);
    expect(result.issues.filter((issue) => issue.code === 'multiple_titles')).toEqual([]);
  });

  it('signale les articles que le contrat de référence ne contient pas', () => {
    // Le contrat d'exemple est un bail court : il ne couvre pas tous les
    // articles du modèle livré (désignation, caution, charges…).
    const result = validate(SAMPLE_BAIL, currentTemplate);
    const missing = result.issues.filter((issue) => issue.code === 'missing_article');
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.map((issue) => issue.message)).toContain('Article « Désignation » absent.');
    for (const issue of missing) {
      expect(issue.severity).toBe('warning');
    }
  });

  it('ne signale aucune construction interdite avec le modèle de bail', () => {
    const result = validate(SAMPLE_BAIL, template);
    expect(result.issues.filter((issue) => issue.code === 'forbidden_construct')).toEqual([]);
  });
});

describe('validate — sous-ensemble interdit', () => {
  it('signale un titre de niveau 4', () => {
    const result = validate('# Titre\n\n#### Sous-titre\n');
    expect(result.issues.map((issue) => issue.code)).toContain('forbidden_construct');
  });

  it('signale une image', () => {
    const result = validate('# Titre\n\n![photo](image.png)\n');
    expect(result.issues.map((issue) => issue.code)).toContain('forbidden_construct');
  });

  it('signale un lien', () => {
    const result = validate('# Titre\n\n[texte](https://example.com)\n');
    expect(result.issues.map((issue) => issue.code)).toContain('forbidden_construct');
  });

  it('signale un bloc de code', () => {
    const result = validate('# Titre\n\n```js\nconst a = 1;\n```\n');
    expect(result.issues.map((issue) => issue.code)).toContain('forbidden_construct');
  });

  it('signale du HTML autre que le saut de page', () => {
    const result = validate('# Titre\n\n<div>texte</div>\n');
    expect(result.issues.map((issue) => issue.code)).toContain('forbidden_construct');
  });

  it('accepte le saut de page', () => {
    const result = validate('# Titre\n\n<!-- pagebreak -->\n');
    expect(result.issues).toEqual([]);
  });

  it('signale un titre manquant', () => {
    const result = validate('## Article 1 – Objet\n');
    expect(result.issues.map((issue) => issue.code)).toContain('missing_title');
  });

  it('signale plusieurs titres', () => {
    const result = validate('# Titre A\n\n# Titre B\n');
    expect(result.issues.map((issue) => issue.code)).toContain('multiple_titles');
  });

  it('signale un espace réservé non fermé', () => {
    const result = validate('# Titre\n\n[À COMPLÉTER : nom\n');
    expect(result.issues.map((issue) => issue.code)).toContain('placeholder_format');
    expect(result.placeholders).toBe(0);
  });

  it('signale un article obligatoire manquant', () => {
    const result = validate('# Titre\n\n## Article 1 – Objet\n', template);
    const missing = result.issues.filter((issue) => issue.code === 'missing_article');
    expect(missing.length).toBeGreaterThan(0);
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
    const reduced: ContractTemplate = {
      ...template,
      required_articles: ['Objet', 'Durée', 'Loyer', 'Obligations du locataire', 'Résiliation', 'Signatures'],
    };
    const result = validate(markdown, reduced);
    expect(result.issues.filter((issue) => issue.code === 'missing_article')).toEqual([]);
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
