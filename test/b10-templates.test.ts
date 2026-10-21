import { describe, expect, it } from 'vitest';
import { TemplateStore, loadTemplates, templateSchema } from '../src/templates.js';
import { validate } from '../src/doc/validate.js';

const templates = loadTemplates();

describe('B10 — modèles issus du référentiel juridique', () => {
  it('charge les neuf modèles', () => {
    expect(templates.length).toBeGreaterThanOrEqual(9);
    const ids = templates.map((template) => template.id);
    expect(ids).toContain('bail-habitation');
    expect(ids).toContain('cdd-terme-precis');
    expect(ids).toContain('cdd-terme-imprecis');
    expect(ids).toContain('cdi');
    expect(ids).toContain('stage-ecole');
    expect(ids).toContain('stage-qualification');
    expect(ids).toContain('apprentissage');
    expect(ids).toContain('teletravail');
    expect(ids).toContain('prestation-service');
  });

  it('les modèles sont valides, publiés et documentés', () => {
    for (const template of templates) {
      expect(templateSchema.safeParse(template).success).toBe(true);
      expect(template.status).toBe('ready');
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.skeleton_markdown.length).toBeGreaterThan(200);
      // Aucun modèle ne doit inventer de règle juridique sans source.
      for (const note of template.legal_notes) {
        expect(note.length).toBeGreaterThan(10);
      }
    }
  });

  it('les squelettes passent la validation sans erreur', () => {
    for (const template of templates) {
      const result = validate(template.skeleton_markdown, template);
      const errors = result.issues.filter((issue) => issue.severity === 'error');
      expect({ template: template.id, errors }).toEqual({ template: template.id, errors: [] });
      // Un seul titre, et des articles.
      expect(result.issues.filter((issue) => issue.code === 'multiple_titles')).toEqual([]);
    }
  });

  it('chaque squelette contient des espaces réservés', () => {
    for (const template of templates) {
      const result = validate(template.skeleton_markdown, template);
      expect(result.placeholders).toBeGreaterThan(3);
    }
  });

  it('chaque modèle a des champs obligatoires et des notes juridiques sourcées', () => {
    for (const template of templates) {
      expect(template.required_fields.length).toBeGreaterThan(2);
      expect(template.legal_notes.length).toBeGreaterThan(0);
      // Chaque note cite une source.
      for (const note of template.legal_notes) {
        expect(note).toMatch(/\[S\d{2}|lacune|Aucun|Interdiction|Doit|Ne |Seul|Adam/i);
      }
    }
  });

  it('le catalogue liste les modèles publiés', () => {
    const store = TemplateStore.load();
    const catalogue = store.catalogue();
    expect(catalogue).toContain('bail-habitation');
    expect(catalogue).toContain('cdd-terme-precis');
    expect(store.summaries().every((summary) => summary.status === 'ready')).toBe(true);
  });
});
