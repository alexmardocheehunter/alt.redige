import { describe, expect, it } from 'vitest';
import { TemplateStore } from '../src/templates.js';
import { validate } from '../src/doc/validate.js';

const store = TemplateStore.load();
const cdd = store.get('cdd-terme-precis')!;
const cddImprecis = store.get('cdd-terme-imprecis')!;
const cdi = store.get('cdi')!;
const stage = store.get('stage-qualification')!;
const prestation = store.get('prestation-service')!;

function validatorCodes(markdown: string, template: typeof cdd): string[] {
  return validate(markdown, template).issues
    .filter((issue) => issue.code.startsWith('validator:'))
    .map((issue) => issue.code);
}

describe('B10 — validateurs juridiques', () => {
  it('signale un CDD de plus de deux ans', () => {
    const markdown = [
      '# Contrat de travail à durée déterminée (terme précis)',
      '',
      '## Article 4 – Durée',
      '',
      'Le contrat est conclu pour une durée de 3 ans à compter du 1er janvier 2026.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdd)).toContain('validator:cdd_duree_max');
  });

  it('accepte un CDD de deux ans', () => {
    const markdown = [
      '# Contrat de travail à durée déterminée (terme précis)',
      '',
      '## Article 4 – Durée',
      '',
      'Le contrat est conclu pour une durée de 2 ans à compter du 1er janvier 2026.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdd)).not.toContain('validator:cdd_duree_max');
  });

  it('signale un salaire inférieur au SMIG', () => {
    const markdown = [
      '# Contrat de travail à durée indéterminée',
      '',
      '## Article 5 – Rémunération',
      '',
      'Le salaire de base est fixé à 45 000 FCFA par mois.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdi)).toContain('validator:cdi_smig');
  });

  it('accepte un salaire supérieur au SMIG', () => {
    const markdown = [
      '# Contrat de travail à durée indéterminée',
      '',
      '## Article 5 – Rémunération',
      '',
      'Le salaire de base est fixé à 150 000 FCFA par mois.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdi)).not.toContain('validator:cdi_smig');
  });

  it('ne compare que le montant qui concerne la règle', () => {
    // Un autre montant (prime, frais) ne doit pas déclencher le contrôle du SMIG.
    const markdown = [
      '# Contrat de travail à durée indéterminée',
      '',
      '## Article 5 – Rémunération',
      '',
      'Le salaire de base est fixé à 150 000 FCFA par mois. Une prime de 20 000 FCFA est versée.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdi)).not.toContain('validator:cdi_smig');
  });

  it('signale une clause de non-concurrence', () => {
    const markdown = [
      '# Contrat de travail à durée déterminée (terme précis)',
      '',
      '## Article 5 – Obligations des parties',
      '',
      "L'employé est soumis à une clause de non-concurrence de deux ans.",
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdd)).toContain('validator:cdd_concurrence_interdite');
  });

  it('signale un CDD à terme imprécis sans motif précis', () => {
    const markdown = [
      '# Contrat de travail à durée déterminée (terme imprécis)',
      '',
      '## Article 3 – Emploi et missions',
      '',
      "L'employé est engagé en qualité de chargé d'études.",
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cddImprecis)).toContain('validator:cdd_imprecis_motif_precis');
  });

  it('accepte un CDD à terme imprécis avec le motif précis', () => {
    const markdown = [
      '# Contrat de travail à durée déterminée (terme imprécis)',
      '',
      '## Article 3 – Emploi et missions',
      '',
      "Objet spécifique du recrutement : renforcement de l'équipe projet pendant la campagne.",
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cddImprecis)).not.toContain('validator:cdd_imprecis_motif_precis');
  });

  it('signale un stage de qualification de plus de douze mois', () => {
    const markdown = [
      '# Contrat de stage de qualification',
      '',
      '## Article 3 – Durée',
      '',
      'Le stage se déroule du 1er janvier 2026 au 31 décembre 2027, soit 24 mois.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, stage)).toContain('validator:stage_qualification_duree_max');
  });

  it('signale un prêt de main-d’œuvre prohibé', () => {
    const markdown = [
      '# Contrat de prestation de services',
      '',
      '## Article 4 – Obligations des parties',
      '',
      "Le Prestataire assure la mise à disposition de main-d'œuvre chez le client.",
      '',
    ].join('\n');
    expect(validatorCodes(markdown, prestation)).toContain('validator:prestation_pret_main_oeuvre');
  });

  it('reste muet quand la valeur n est pas dans le document', () => {
    const markdown = [
      '# Contrat de travail à durée déterminée (terme précis)',
      '',
      '## Article 1 – Textes de référence',
      '',
      'Le contrat est régi par le Code du travail.',
      '',
    ].join('\n');
    expect(validatorCodes(markdown, cdd)).toEqual([]);
  });
});
