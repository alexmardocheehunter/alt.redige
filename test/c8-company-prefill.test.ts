import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { TemplateStore } from '../src/templates.js';
import { executeTool, type ToolContext } from '../src/agent/tools.js';
import { applyCompanyProfilePrefill, companyValueForPlaceholder } from '../src/company/prefill.js';
import { companyProfilePromptText, isProfileSaveConfirmed } from '../src/company/profile.js';
import type { CompanyProfile, CompanyProfileInput } from '../src/company/store.js';
import { MemoryCompanyProfileStore } from './company-fake.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    id: 'profil-a1',
    label: 'Ma société',
    legal_name: 'Alpha SARL',
    legal_form: 'SARL',
    capital: '1 000 000 FCFA',
    rccm: 'CI-ABJ-2026-B-00000',
    tax_id: '0000000 A',
    address: 'Cocody, Rue des Jardins',
    city: 'Abidjan',
    postal_box: '01 BP 0000 Abidjan 01',
    representative_first_name: 'Awa',
    representative_last_name: 'Kone',
    representative_role: 'Gérante',
    phone: '+225 00 00 00 00 00',
    email: 'contact@exemple.ci',
    signature_place: 'Abidjan',
    logo: '',
    is_default: true,
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T10:00:00.000Z',
    ...overrides,
  };
}

function profileInput(source: CompanyProfile = profile()): CompanyProfileInput {
  return {
    label: source.label,
    legal_name: source.legal_name,
    legal_form: source.legal_form,
    capital: source.capital,
    rccm: source.rccm,
    tax_id: source.tax_id,
    address: source.address,
    city: source.city,
    postal_box: source.postal_box,
    representative_first_name: source.representative_first_name,
    representative_last_name: source.representative_last_name,
    representative_role: source.representative_role,
    phone: source.phone,
    email: source.email,
    signature_place: source.signature_place,
    logo: source.logo,
    is_default: source.is_default,
  };
}

function toolContext(
  store: MemoryCompanyProfileStore | null,
  current: CompanyProfile | null,
  lastUserText: string,
): { events: any[]; context: ToolContext } {
  const events: any[] = [];
  const fake = new FakeOpenRouter({ turns: [] });
  return {
    events,
    context: {
      workingDoc: null,
      workingDocType: null,
      templates: TemplateStore.load(),
      emit: (event, data) => { events.push({ event, data }); },
      nextVersion: () => 1,
      logger: createLogger('error'),
      client: fakeClient(fake),
      safetyModel: 'test-safety',
      safetyEnabled: false,
      safetyMode: 'off',
      userText: lastUserText,
      lastUserText,
      companyProfile: current,
      companyProfileStore: store,
      uid: store ? 'uid-a' : null,
      documentVersion: 1,
      maxEditChangedBlocks: 6,
      askUserCounter: 0,
      signal: new AbortController().signal,
    },
  };
}

describe('préremplissage déterministe du profil entreprise', () => {
  it('remplit uniquement les espaces réservés employeur', () => {
    const markdown = [
      '# Contrat',
      '',
      'Entre [À COMPLÉTER : raison sociale de l’employeur],',
      'dont le siège est à [À COMPLÉTER : adresse du siège],',
      'représentée par [À COMPLÉTER : nom et prénom du représentant de l’employeur],',
      '[À COMPLÉTER : qualité du représentant],',
      'et [À COMPLÉTER : nom et qualité du représentant].',
      '',
      'Salarié : [À COMPLÉTER : nom du salarié], demeurant [À COMPLÉTER : adresse du salarié].',
      'Bailleur : [À COMPLÉTER : raison sociale du bailleur].',
      'Fait à [À COMPLÉTER : lieu].',
    ].join('\n');

    const result = applyCompanyProfilePrefill(markdown, profile(), 'cdi');
    expect(result.filled).toBe(6);
    expect(result.markdown).toContain('Alpha SARL');
    expect(result.markdown).toContain('Cocody, Rue des Jardins, Abidjan, 01 BP 0000 Abidjan 01');
    expect(result.markdown).toContain('Awa Kone');
    expect(result.markdown).toContain('Gérante');
    expect(result.markdown).toContain('Awa Kone, Gérante');
    expect(result.markdown).toContain('Fait à Abidjan.');
    expect(result.markdown).toContain('[À COMPLÉTER : nom du salarié]');
    expect(result.markdown).toContain('[À COMPLÉTER : adresse du salarié]');
    expect(result.markdown).toContain('[À COMPLÉTER : raison sociale du bailleur]');
    expect(result.remaining).toBe(3);
  });

  it('ne touche pas un contrat où l’entreprise n’est pas forcément l’employeur', () => {
    const markdown = [
      'Entre [À COMPLÉTER : raison sociale du bailleur]',
      'et [À COMPLÉTER : nom complet du locataire].',
      'Fait à [À COMPLÉTER : lieu].',
    ].join('\n');
    const result = applyCompanyProfilePrefill(markdown, profile(), 'bail-habitation');
    expect(result.filled).toBe(0);
    expect(result.markdown).toBe(markdown);
    expect(result.remaining).toBe(3);
  });

  it('normalise les libellés (accents, apostrophes, majuscules)', () => {
    expect(companyValueForPlaceholder('RAISON SOCIALE DE L’EMPLOYEUR', profile())).toBe('Alpha SARL');
    expect(companyValueForPlaceholder('Adresse de l’entreprise', profile())).toBe(
      'Cocody, Rue des Jardins, Abidjan, 01 BP 0000 Abidjan 01',
    );
    expect(companyValueForPlaceholder('LIEU', profile())).toBe('Abidjan');
  });

  it('ne remplit pas les libellés ambigus de l’autre partie', () => {
    expect(companyValueForPlaceholder('nom et qualité du représentant du bailleur', profile())).toBeNull();
    expect(companyValueForPlaceholder('adresse de l’apprenti', profile())).toBeNull();
    expect(companyValueForPlaceholder('nom et prénom de l’apprenti', profile())).toBeNull();
  });

  it('normalise les retours à la ligne et ignore un profil vide', () => {
    const result = applyCompanyProfilePrefill(
      '[À COMPLÉTER : raison sociale de l’employeur]',
      profile({ legal_name: 'Alpha\nSARL' }),
      'cdi',
    );
    expect(result.markdown).toBe('Alpha SARL');
    const empty = applyCompanyProfilePrefill(
      '[À COMPLÉTER : raison sociale de l’employeur]',
      profile({ legal_name: '' }),
      'cdi',
    );
    expect(empty.filled).toBe(0);
  });

  it('injecte le profil dans le prompt sans le logo', () => {
    const text = companyProfilePromptText(profile({
      logo: 'data:image/png;base64,AAAA',
    }));
    expect(text).toContain('Alpha SARL');
    expect(text).toContain('Awa Kone');
    expect(text).not.toContain('data:image');
  });

  it('ne confond pas une description avec une confirmation', () => {
    expect(isProfileSaveConfirmed('Oui, je confirme.')).toBe(true);
    expect(isProfileSaveConfirmed('Enregistre mon profil.')).toBe(true);
    expect(isProfileSaveConfirmed('Mon entreprise s’appelle Alpha SARL.')).toBe(false);
    expect(isProfileSaveConfirmed('Non, ne l’enregistre pas.')).toBe(false);
    expect(isProfileSaveConfirmed('')).toBe(false);
    expect(isProfileSaveConfirmed('x'.repeat(170))).toBe(false);
  });
});

describe('outil save_company_profile — confirmation et isolation', () => {
  it('refuse sans confirmation explicite et n’écrit rien', async () => {
    const store = new MemoryCompanyProfileStore();
    const { context } = toolContext(store, null, 'Mon entreprise s’appelle Alpha SARL.');
    const result = await executeTool('save_company_profile', {
      legal_name: 'Alpha SARL',
      confirmed: true,
    }, context);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).code).toBe('confirmation_required');
    expect(await store.list('uid-a')).toEqual([]);
  });

  it('refuse `confirmed: true` si le dernier message n’est pas une confirmation', async () => {
    const store = new MemoryCompanyProfileStore();
    const { context } = toolContext(store, null, 'Oui.');
    const result = await executeTool('save_company_profile', {
      legal_name: 'Alpha SARL',
      confirmed: false,
    }, context);
    expect(result.isError).toBe(true);
    expect(await store.list('uid-a')).toEqual([]);
  });

  it('enregistre après un oui explicite et met à jour le contexte', async () => {
    const store = new MemoryCompanyProfileStore();
    const { context } = toolContext(store, null, 'Oui, je confirme.');
    const result = await executeTool('save_company_profile', {
      legal_name: 'Alpha SARL',
      address: 'Cocody',
      city: 'Abidjan',
      representative_first_name: 'Awa',
      representative_last_name: 'Kone',
      confirmed: true,
    }, context);
    expect(result.isError).toBe(false);
    const stored = await store.list('uid-a');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.legal_name).toBe('Alpha SARL');
    expect(stored[0]!.is_default).toBe(true);
    expect(context.companyProfile?.id).toBe(stored[0]!.id);
  });

  it('met à jour le profil courant sans créer de doublon', async () => {
    const store = new MemoryCompanyProfileStore();
    const existing = await store.put('uid-a', 'profil-a1', profileInput());
    const { context } = toolContext(store, existing, 'Oui, enregistre la modification.');
    const result = await executeTool('save_company_profile', {
      legal_name: 'Alpha modifiée',
      confirmed: true,
    }, context);
    expect(result.isError).toBe(false);
    const list = await store.list('uid-a');
    expect(list).toHaveLength(1);
    expect(list[0]!.legal_name).toBe('Alpha modifiée');
  });

  it('ne renvoie jamais le logo au modèle', async () => {
    const store = new MemoryCompanyProfileStore();
    const existing = await store.put('uid-a', 'profil-a1', profileInput(profile({
      logo: 'data:image/png;base64,AAAA',
    })));
    const { context } = toolContext(store, existing, 'Bonjour');
    const result = await executeTool('get_company_profile', {}, context);
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain('data:image');
    expect(JSON.parse(result.content).profile.has_logo).toBe(true);
  });

  it('refuse la sauvegarde avec le code partagé', async () => {
    const { context } = toolContext(null, null, 'Oui.');
    const result = await executeTool('save_company_profile', {
      legal_name: 'Alpha SARL',
      confirmed: true,
    }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('connexion Google');
  });
});

describe('create_canvas préremplit avant validation', () => {
  it('remplace les champs employeur et laisse les autres comptés', async () => {
    const store = new MemoryCompanyProfileStore();
    const current = profile();
    const markdown = [
      '# Contrat de travail à durée indéterminée',
      '',
      'Entre [À COMPLÉTER : raison sociale de l’employeur],',
      'dont le siège est à [À COMPLÉTER : adresse du siège],',
      'représentée par [À COMPLÉTER : nom et qualité du représentant].',
      '',
      'Le salarié est [À COMPLÉTER : nom du salarié].',
      '',
      'Fait à [À COMPLÉTER : lieu], le [À COMPLÉTER : date].',
      '',
      '## Article 1 – Objet',
      '',
      'Le présent contrat est conclu pour un poste de développeur.',
    ].join('\n');
    const { context, events } = toolContext(
      store,
      current,
      `Je veux un CDI pour un développeur.\n${companyProfilePromptText(current)}`,
    );
    context.templates = TemplateStore.load();
    const result = await executeTool('create_canvas', {
      title: 'Contrat de travail',
      contract_type: 'cdi',
      markdown,
    }, context);

    expect(result.isError).toBe(false);
    const set = events.find((event) => event.event === 'canvas_set');
    expect(set).toBeTruthy();
    expect(set.data.markdown).toContain('Alpha SARL');
    expect(set.data.markdown).toContain('Cocody, Rue des Jardins');
    expect(set.data.markdown).toContain('Awa Kone, Gérante');
    expect(set.data.markdown).toContain('Fait à Abidjan');
    expect(set.data.markdown).toContain('[À COMPLÉTER : nom du salarié]');
    expect(set.data.markdown).toContain('[À COMPLÉTER : date]');
    expect(set.data.validation.placeholders).toBe(2);
    expect(set.data.validation.fields.required.find((field: any) => field.key === 'employeur').filled).toBe(true);
  });
});
