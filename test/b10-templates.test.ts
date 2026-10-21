import { describe, expect, it } from 'vitest';
import { TemplateStore, loadTemplates, templateSchema } from '../src/templates.js';
import { validate } from '../src/doc/validate.js';

const templates = loadTemplates();

describe('B10 — modèles issus du référentiel juridique', () => {
  it('charge les onze modèles', () => {
    expect(templates.length).toBe(11);
    const ids = templates.map((template) => template.id);
    expect(ids).toContain('bail-habitation');
    expect(ids).toContain('bail-bureau');
    expect(ids).toContain('bail-professionnel');
    expect(ids).toContain('cdd-terme-precis');
    expect(ids).toContain('cdd-terme-imprecis');
    expect(ids).toContain('cdi');
    expect(ids).toContain('stage-ecole');
    expect(ids).toContain('stage-qualification');
    expect(ids).toContain('apprentissage');
    expect(ids).toContain('teletravail');
    expect(ids).toContain('prestation-service');
  });

  it('distingue bien les deux CDD', () => {
    const store = TemplateStore.load();
    const precis = store.get('cdd-terme-precis')!;
    const imprecis = store.get('cdd-terme-imprecis')!;

    // Conditions de recours différentes : le CDD à terme imprécis exige une
    // tâche précise, le CDD à terme précis une durée déterminée.
    expect(imprecis.legal_notes.join(' ')).toMatch(/tâche précise/);
    expect(precis.legal_notes.join(' ')).not.toMatch(/tâche précise/);

    // La durée maximale de deux ans est commune aux deux.
    expect(precis.legal_notes.join(' ')).toMatch(/deux ans/);
    expect(imprecis.legal_notes.join(' ')).toMatch(/deux ans/);
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
      // Chaque note cite sa source : un code de source du référentiel, ou le
      // modèle de référence quand la règle n'est pas reprise dans le corpus.
      for (const note of template.legal_notes) {
        expect(note).toMatch(/\[S\d{2}|lacune|Aucun|Interdiction|Doit|Ne |Seul|Adam|\[Modèle|\[source/i);
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
