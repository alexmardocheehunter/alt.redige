import { describe, expect, it } from 'vitest';
import { executeTool, toolDefinitions } from '../src/agent/tools.js';
import type { AgentEmit, AgentEventName, AgentEventPayloads } from '../src/agent/events.js';
import {
  articleRanges,
  findArticleRange,
  hasSignatureTable,
  insertBlock,
  insertSignatureBlock,
  listToMarkdown,
  newEngagingArticles,
  replaceArticleBody,
  tableToMarkdown,
  userConsentedToClause,
} from '../src/doc/blocks.js';
import { computeDate } from '../src/doc/dates.js';
import { listPlaceholders } from '../src/doc/placeholders.js';
import { blockingStructureIssues, structureIssues } from '../src/doc/structure-check.js';
import { validate } from '../src/doc/validate.js';
import {
  buildSystemPrompt,
  formatNow,
  NOW_MARKER,
  resetPromptCache,
} from '../src/agent/prompt.js';
import { buildSuggestions } from '../src/agent/progress.js';
import { createLogger } from '../src/logger.js';
import { TemplateStore } from '../src/templates.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';
import { SAMPLE_BAIL } from './fixtures.js';

function collector() {
  const events: Array<{ event: string; data: unknown }> = [];
  const emit: AgentEmit = <K extends AgentEventName>(event: K, data: AgentEventPayloads[K]) => {
    events.push({ event, data });
  };
  return { events, emit };
}

function toolContext(overrides: Partial<Parameters<typeof executeTool>[2]> = {}) {
  const { events, emit } = collector();
  const fake = new FakeOpenRouter({ turns: [] });
  const base: Parameters<typeof executeTool>[2] = {
    workingDoc: null,
    workingDocType: null,
    templates: TemplateStore.load(),
    emit,
    nextVersion: () => 2,
    logger: createLogger('error'),
    client: fakeClient(fake),
    safetyModel: 'test-safety',
    safetyEnabled: false,
    safetyMode: 'off',
    userText: 'Je veux un bail pour un studio.',
    lastUserText: 'Je veux un bail pour un studio.',
    companyProfile: null,
    companyProfileStore: null,
    uid: null,
    documentVersion: 1,
    maxEditChangedBlocks: 20,
    askUserCounter: 0,
    signal: new AbortController().signal,
    now: new Date('2026-10-27T12:00:00.000Z'),
  };
  return { events, context: { ...base, ...overrides } };
}

describe('dates — compute_date', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');

  it('calcule le lundi suivant puis trois mois', () => {
    const result = computeDate({ start: 'next_monday', add: { months: 3 }, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.start).toBe('2026-11-02');
    expect(result.value.end).toBe('2027-02-02');
    expect(result.value.formatted).toContain('mardi 2 février 2027');
  });

  it('compte inclusivement la veille de l’anniversaire', () => {
    const result = computeDate({ start: 'lundi prochain', add: { months: 3 }, inclusive: true, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.end).toBe('2027-02-01');
    expect(result.value.inclusive).toBe(true);
  });

  it('ne recule pas avant le départ si la période est incluse sans durée', () => {
    const result = computeDate({ start: '2026-10-27', inclusive: true, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.end).toBe('2026-10-27');
  });

  it('borne les mois au dernier jour du mois cible', () => {
    const result = computeDate({ start: '2026-01-31', add: { months: 1 }, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.end).toBe('2026-02-28');
  });

  it('utilise la date civile d’Abidjan', () => {
    const late = computeDate({ start: 'today', now: new Date('2026-10-26T23:30:00.000Z') });
    const early = computeDate({ start: 'today', now: new Date('2026-10-27T00:30:00.000Z') });
    expect(late.ok && late.value.end).toBe('2026-10-26');
    expect(early.ok && early.value.end).toBe('2026-10-27');
  });

  it('refuse une date invalide sans inventer de résultat', () => {
    const result = computeDate({ start: '32/13/2026', now });
    expect(result.ok).toBe(false);
  });
});

describe('placeholders — list_placeholders', () => {
  it('compte et localise les champs du bail', () => {
    const report = listPlaceholders(SAMPLE_BAIL);
    expect(report.count).toBe(8);
    expect(report.items[0]?.raw).toContain('nom complet du bailleur');
    expect(report.items[0]?.article).toBeNull();
    expect(report.by_article.find((item) => item.article?.includes('Durée'))?.count).toBe(2);
    expect(report.by_article.find((item) => item.article?.includes('Signatures'))?.count).toBe(1);
  });

  it('ignore les crochets qui ne sont pas des champs', () => {
    const report = listPlaceholders('# Contrat\n\n[note libre] et [À COMPLÉTER : date].');
    expect(report.count).toBe(1);
    expect(report.items[0]?.label).toBe('date');
  });
});

describe('blocs Markdown structurés', () => {
  it('retrouve un article par numéro', () => {
    const ranges = articleRanges(SAMPLE_BAIL);
    expect(ranges).toHaveLength(5);
    const article4 = findArticleRange(SAMPLE_BAIL, '4');
    expect(article4?.label).toContain('Résiliation');
    expect(findArticleRange(SAMPLE_BAIL, 'Signatures')?.number).toBe(5);
  });

  it('remplace seulement le corps de l’article et conserve les signatures', () => {
    const after = replaceArticleBody(SAMPLE_BAIL, '4', '1. Le préavis est de trois mois.');
    expect(after).toContain('## Article 4');
    expect(after).toContain('Le préavis est de trois mois.');
    expect(after).not.toContain('Le congé est notifié');
    expect(after).toContain('## Article 5');
    expect(after).toContain('| Le Bailleur | Le Locataire |');
  });

  it('insère un bloc à la fin d’un article sans perdre le suivant', () => {
    const after = insertBlock(SAMPLE_BAIL, '- mission principale\n- missions complémentaires', 'Article 3');
    expect(after).toContain('- mission principale');
    expect(after).toContain('## Article 4');
    expect(after).toContain('## Article 5');
  });

  it('produit des tableaux GFM rectangulaires et échappe les tuyaux', () => {
    const table = tableToMarkdown([
      ['Partie', 'Montant'],
      ['Bailleur | mandataire', '70 000'],
      ['Locataire'],
    ]);
    expect(table).toContain('| Bailleur \\| mandataire | 70 000 |');
    expect(table).toContain('| Locataire |  |');
    expect(table.split('\n')).toHaveLength(4);
  });

  it('produit des listes ordonnées avec le bon départ', () => {
    expect(listToMarkdown(['un', 'deux'], true, 3)).toBe('3. un\n4. deux');
    expect(listToMarkdown(['un', 'deux'])).toBe('- un\n- deux');
  });

  it('remplace le tableau de signatures existant par un tableau déterministe', () => {
    const parties = [
      { name: 'Koné', first_name: 'Jean', role: 'Bailleur' },
      { name: 'Aya', first_name: 'Marie', role: 'Locataire' },
    ];
    const first = insertSignatureBlock(SAMPLE_BAIL, parties);
    const second = insertSignatureBlock(SAMPLE_BAIL, parties);
    expect(first).toBe(second);
    expect(hasSignatureTable(first)).toBe(true);
    expect(first).toContain('| Signature : | Signature : |');
    expect(first).toContain('| Nom : Koné | Nom : Aya |');
    expect(first).toContain('| Prénom : Jean | Prénom : Marie |');
    expect(first).toContain('Lu et approuvé');
  });

  it('crée un article Signatures quand il n’en existe pas', () => {
    const withoutSignature = '# Contrat\n\n## Article 1 – Objet\n\nTexte.\n';
    const after = insertSignatureBlock(withoutSignature, [{ name: 'Koné', role: 'Bailleur' }]);
    expect(after).toContain('## Article 2 – Signatures');
    expect(hasSignatureTable(after)).toBe(true);
  });

  it('détecte une clause engageante nouvelle et le consentement explicite', () => {
    const after = `${SAMPLE_BAIL}\n\n## Article 6 – Priorité d’embauche\n\nSix mois.\n`;
    expect(newEngagingArticles(SAMPLE_BAIL, after)).toEqual(['Article 6 – Priorité d’embauche']);
    expect(userConsentedToClause('Ajoute une clause de priorité d’embauche')).toBe(true);
    expect(userConsentedToClause('Crée un bail avec une clause de pénalité')).toBe(true);
    expect(userConsentedToClause('Oui, je confirme')).toBe(true);
    expect(userConsentedToClause('Je veux un bail pour un studio')).toBe(false);
    expect(userConsentedToClause('Crée un bail')).toBe(false);
    expect(userConsentedToClause('Que signifie cette clause ?')).toBe(false);
  });
});

describe('structure — tableaux et numérotation', () => {
  it('accepte le bail de référence', () => {
    expect(structureIssues(SAMPLE_BAIL)).toEqual([]);
    expect(blockingStructureIssues(SAMPLE_BAIL)).toEqual([]);
  });

  it('signale un tableau sans ligne de séparation', () => {
    const issues = structureIssues('| A | B |\n| x | y |\n');
    expect(issues.map((issue) => issue.code)).toContain('malformed_table');
  });

  it('signale des colonnes incohérentes', () => {
    const issues = structureIssues('| A | B |\n|---|---|\n| x |\n');
    expect(issues.map((issue) => issue.code)).toContain('table_column_mismatch');
  });

  it('signale les numéros d’article en double', () => {
    const issues = structureIssues('## Article 1 – A\n\n## Article 1 – B\n');
    expect(issues.map((issue) => issue.code)).toContain('duplicate_article_number');
  });

  it('intègre les problèmes de structure à la validation générale', () => {
    const result = validate('| A | B |\n| x | y |\n');
    expect(result.issues.map((issue) => issue.code)).toContain('malformed_table');
  });
});

describe('prompt système — date courante', () => {
  it('formate l’heure d’Abidjan sans dépendre du fuseau de la machine', () => {
    const formatted = formatNow(new Date('2026-10-27T12:00:00.000Z'));
    expect(formatted).toContain('mardi 27 octobre 2026');
    expect(formatted).toContain('Africa/Abidjan');
  });

  it('injecte la date et retire le marqueur', () => {
    resetPromptCache();
    const prompt = buildSystemPrompt(TemplateStore.load(), {
      now: new Date('2026-10-27T12:00:00.000Z'),
    });
    expect(prompt).not.toContain(NOW_MARKER);
    expect(prompt).toContain('mardi 27 octobre 2026');
    expect(prompt).toContain('compute_date');
    expect(prompt).toContain('suggest_next_actions');
    expect(prompt).toContain('stage de qualification');
    expect(prompt).toContain('tableaux complets');
    expect(prompt).toContain('remerciement');
    expect(prompt).toContain("Bail d'habitation");
  });
});

describe('suggestions dynamiques', () => {
  it('propose d’abord les champs restants et respecte quatre mots', () => {
    const suggestions = buildSuggestions({
      hasDocument: true,
      placeholders: 2,
      askedUser: false,
      markdown: '# Contrat\n\n## Article 5 – Signatures\n\n| Le Bailleur |\n|---|',
    });
    expect(suggestions[0]?.label).toBe('Compléter les champs');
    expect(suggestions.map((item) => item.label)).not.toContain('Ajouter les signatures');
    expect(suggestions).toHaveLength(3);
    for (const item of suggestions) {
      expect(item.label.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });

  it('ne propose pas de signatures quand elles existent', () => {
    const suggestions = buildSuggestions({
      hasDocument: true,
      placeholders: 0,
      askedUser: false,
      markdown: '# Contrat\n\n## Article 5 – Signatures\n\n| A | B |\n|---|---|\n| x | y |',
    });
    expect(suggestions.map((item) => item.label)).not.toContain('Ajouter les signatures');
  });

  it('ne propose rien quand une question est en attente', () => {
    expect(buildSuggestions({ hasDocument: true, placeholders: 1, askedUser: true })).toEqual([]);
  });

  it('propose trois types de contrat quand le document est vide', () => {
    const suggestions = buildSuggestions({ hasDocument: false, placeholders: 0, askedUser: false });
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]?.label).toBe('Créer un bail');
  });
});

describe('outils structurés — exécution', () => {
  it('expose les nouveaux outils au modèle', () => {
    const names = toolDefinitions(TemplateStore.load()).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'compute_date',
      'list_placeholders',
      'edit_article',
      'insert_table',
      'insert_list',
      'insert_signature_block',
      'suggest_next_actions',
    ]));
  });

  it('compute_date utilise l’horloge injectée', async () => {
    const { context } = toolContext();
    const result = await executeTool('compute_date', {
      start: 'next_monday',
      add: { months: 3 },
      inclusive: false,
    }, context);
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload.end).toBe('2027-02-02');
  });

  it('list_placeholders renvoie le décompte réel', async () => {
    const { context } = toolContext({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('list_placeholders', {}, context);
    const payload = JSON.parse(result.content);
    expect(payload.count).toBe(8);
    expect(payload.by_article.length).toBeGreaterThan(1);
  });

  it('edit_article conserve les autres articles et les signatures', async () => {
    const { events, context } = toolContext({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('edit_article', {
      article: '4',
      markdown: '1. Le préavis est de trois mois.\n2. Le congé est notifié par écrit.',
    }, context);
    expect(result.isError).toBe(false);
    expect(context.workingDoc).toContain('Le préavis est de trois mois.');
    expect(context.workingDoc).toContain('## Article 5');
    const set = events.find((event) => event.event === 'canvas_set');
    expect(set).toBeTruthy();
  });

  it('insert_list ajoute une vraie liste dans l’article visé', async () => {
    const { context } = toolContext({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('insert_list', {
      article: '3',
      items: ['payer le loyer', 'entretenir les lieux'],
    }, context);
    expect(result.isError).toBe(false);
    expect(context.workingDoc).toContain('- payer le loyer\n- entretenir les lieux');
    expect(context.workingDoc).toContain('## Article 4');
  });

  it('insert_table ajoute un tableau GFM', async () => {
    const { context } = toolContext({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('insert_table', {
      article: '2',
      rows: [['Échéance', 'Montant'], ['5 du mois', '70 000 FCFA']],
    }, context);
    expect(result.isError).toBe(false);
    expect(context.workingDoc).toContain('| Échéance | Montant |');
    expect(context.workingDoc).toContain('|---|---|');
  });

  it('insert_signature_block est déterministe et produit un tableau', async () => {
    const { context } = toolContext({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('insert_signature_block', {
      parties: [
        { name: 'Koné', first_name: 'Jean', role: 'Bailleur' },
        { name: 'Aya', first_name: 'Marie', role: 'Locataire' },
      ],
    }, context);
    expect(result.isError).toBe(false);
    expect(hasSignatureTable(context.workingDoc ?? '')).toBe(true);
    expect(context.workingDoc).toContain('| Signature : | Signature : |');
  });

  it('suggest_next_actions émet au plus trois suggestions', async () => {
    const { events, context } = toolContext({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('suggest_next_actions', {}, context);
    expect(result.isError).toBe(false);
    const suggestions = events.find((event) => event.event === 'suggestions');
    const items = (suggestions?.data as { items?: unknown[] } | undefined)?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(3);
  });
});
