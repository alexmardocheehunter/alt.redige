/**
 * B11 — garde-fous ajoutés par la vérification de l'audit.
 *
 * Chaque test décrit un défaut reproduit par l'audit, et le comportement
 * attendu après correction. Ils sont regroupés par constat.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { testApp, readJson } from './helpers.js';
import { FakeOpenRouter, fakeClient, parseSse } from './fake-llm.js';
import { executeTool, toolDefinitions, type ToolContext } from '../src/agent/tools.js';
import { TemplateStore } from '../src/templates.js';
import { createLogger } from '../src/logger.js';
import { validate } from '../src/doc/validate.js';
import { loadConfig } from '../src/config.js';
import { resetRateLimits, rateLimit } from '../src/middleware/rateLimit.js';
import { SAMPLE_BAIL } from './fixtures.js';

/* ------------------------------------------------------------------ */
/* Outils                                                               */
/* ------------------------------------------------------------------ */

function toolContext(overrides: Partial<ToolContext> = {}): { events: any[]; context: ToolContext } {
  const events: any[] = [];
  const fake = new FakeOpenRouter({ turns: [] });
  const base: ToolContext = {
    workingDoc: null,
    workingDocType: null,
    templates: TemplateStore.load(),
    emit: (event, data) => { events.push({ event, data }); },
    nextVersion: () => 1,
    logger: createLogger('error'),
    client: fakeClient(fake),
    safetyModel: 'nvidia/nemotron-3.5-content-safety:free',
    safetyEnabled: false,
    safetyMode: 'advisory',
    userText: 'Je veux un bail d habitation pour un studio a Cocody, loyer 150 000 FCFA par mois, duree 12 mois, bailleur Monsieur Koné, locataire Madame Aya.',
    lastUserText: 'Je veux un bail d habitation pour un studio a Cocody.',
    companyProfile: null,
    companyProfileStore: null,
    uid: null,
    documentVersion: 1,
    maxEditChangedBlocks: 4,
    askUserCounter: 0,
    signal: new AbortController().signal,
  };
  return { events, context: { ...base, ...overrides } };
}

/** Un bail complet : parties, loyer, durée, préavis, signatures. */
const BAIL_COMPLET = [
  '# Contrat de bail à usage d\'habitation',
  '',
  'Entre les soussignés :',
  '',
  '**Monsieur Koné**, demeurant à Abidjan, ci-après le **Bailleur**,',
  '',
  'et',
  '',
  '**Madame Aya**, demeurant à Cocody, ci-après la **Locataire**,',
  '',
  '## Article 1 – Objet du contrat',
  '',
  'Le Bailleur donne à bail un studio situé à Cocody.',
  '',
  '## Article 2 – Durée',
  '',
  'Le bail est conclu pour une durée de 12 mois.',
  '',
  '## Article 3 – Loyer',
  '',
  'Le loyer mensuel est fixé à 150 000 FCFA.',
  '',
  '## Article 4 – Résiliation',
  '',
  'Chaque partie peut résilier moyennant un préavis de deux (2) mois.',
  '',
  '## Article 5 – Signatures',
  '',
  'Fait à Abidjan, en deux exemplaires originaux.',
].join('\n');

/* ------------------------------------------------------------------ */
/* P0-2 — une modification ciblée ne doit pas supprimer un article      */
/* ------------------------------------------------------------------ */

describe('P0-2 — une modification ne fait pas disparaître un article', () => {
  it('refuse une modification qui supprime le bloc de signatures', async () => {
    const { events, context } = toolContext({ workingDoc: BAIL_COMPLET, workingDocType: 'bail-habitation' });

    const result = await executeTool('edit_canvas', {
      edits: [{
        old_str: '## Article 5 – Signatures\n\nFait à Abidjan, en deux exemplaires originaux.',
        new_str: '',
      }],
    }, context);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content);
    expect(payload.code).toBe('article_lost');
    expect(payload.lost_articles.join(' ')).toContain('Signatures');
    // Le document n'est pas modifié.
    expect(context.workingDoc).toBe(BAIL_COMPLET);
    expect(events).toHaveLength(0);
  });

  it('refuse une modification qui réécrit tout le document', async () => {
    const { context } = toolContext({ workingDoc: BAIL_COMPLET, workingDocType: 'bail-habitation' });

    const result = await executeTool('edit_canvas', {
      edits: [{
        old_str: 'Le loyer mensuel est fixé à 150 000 FCFA.',
        new_str: 'Le loyer mensuel est fixé à 200 000 FCFA.\n\nUn paragraphe de plus.\n\nUn autre.\n\nEncore un.\n\nEt un dernier.',
      }],
    }, context);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).code).toBe('too_many_changes');
    expect(context.workingDoc).toBe(BAIL_COMPLET);
  });

  it('accepte une modification ciblée qui préserve les autres articles', async () => {
    const { events, context } = toolContext({ workingDoc: BAIL_COMPLET, workingDocType: 'bail-habitation' });

    const result = await executeTool('edit_canvas', {
      edits: [{
        old_str: 'moyennant un préavis de deux (2) mois',
        new_str: 'moyennant un préavis de trois (3) mois',
      }],
    }, context);

    expect(result.isError).toBe(false);
    expect(result.emittedCanvasSet).toBe(true);
    expect(context.workingDoc).toContain('trois (3) mois');
    expect(context.workingDoc).toContain('## Article 5 – Signatures');
    expect(events.map((event) => event.event)).toEqual(['canvas_start', 'canvas_set']);
  });
});

/* ------------------------------------------------------------------ */
/* P0-3 — pas de contrat sans information exploitable                  */
/* ------------------------------------------------------------------ */

describe('P0-3 — pas de contrat sans information exploitable', () => {
  it('pose une question au lieu de rédiger un bail à partir d\'une demande vide', async () => {
    const { events, context } = toolContext({ userText: 'Je veux faire un bail.' });

    const result = await executeTool('create_canvas', {
      title: 'Contrat de bail',
      contract_type: 'bail-habitation',
      markdown: BAIL_COMPLET,
    }, context);

    // Le garde-fou ne se contente pas de refuser : il pose la question
    // (AGENT-PROTOCOL.md §8), et le tour s'arrête sur `awaiting_input`.
    expect(result.askedUser).toBe(true);
    const payload = JSON.parse(result.content);
    expect(payload.missing_required_fields.length).toBeGreaterThan(0);

    const asked = events.find((event) => event.event === 'ask_user');
    expect(asked).toBeDefined();
    expect(asked.data.kind).toBe('form');
    expect(asked.data.question_id).toMatch(/^q_/);
    expect(asked.data.blocking).toBe(true);
    expect(asked.data.fields.length).toBeGreaterThan(0);

    // Aucun document n'a été écrit.
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(0);
    expect(context.workingDoc).toBeNull();
  });

  it('accepte de rédiger quand l\'utilisateur a fourni les informations', async () => {
    const { events, context } = toolContext();

    const result = await executeTool('create_canvas', {
      title: 'Contrat de bail',
      contract_type: 'bail-habitation',
      markdown: BAIL_COMPLET,
    }, context);

    expect(result.isError).toBe(false);
    expect(result.askedUser).toBeUndefined();
    expect(events.map((event) => event.event)).toContain('canvas_set');
  });
});

/* ------------------------------------------------------------------ */
/* P1-1 / P2-2 — liste blanche des types de contrat                     */
/* ------------------------------------------------------------------ */

describe('P1-1 — un type de contrat hors catalogue est refusé', () => {
  it('refuse un type inconnu', async () => {
    const { events, context } = toolContext();

    const result = await executeTool('create_canvas', {
      title: 'Contrat de prestation',
      contract_type: 'prestation-services',
      markdown: '# Contrat de prestation de services\n\n## Article 1 – Objet\n\nTexte.\n',
    }, context);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content);
    expect(payload.error).toContain('inconnu');
    expect(payload.valid_contract_types).toContain('bail-habitation');
    expect(events).toHaveLength(0);
  });

  it('n\'expose que les types du catalogue dans le schéma de l\'outil', () => {
    const definitions = toolDefinitions(TemplateStore.load());
    const create = definitions.find((tool) => tool.name === 'create_canvas')!;
    const get = definitions.find((tool) => tool.name === 'get_template')!;
    const ids = TemplateStore.load().all().map((template) => template.id);
    expect((create.parameters.properties as any).contract_type.enum).toBeUndefined();
    expect((get.parameters.properties as any).contract_type.enum).toEqual(ids);
  });
});

/* ------------------------------------------------------------------ */
/* P1-2 — aucune mention normative hors du référentiel                  */
/* ------------------------------------------------------------------ */

describe('P1-2 — les mentions normatives sont encadrées', () => {
  it('refuse un document qui cite un texte absent des notes juridiques', async () => {
    const { events, context } = toolContext();
    const markdown = BAIL_COMPLET + '\n\nLe présent bail est régi par le Code civil.\n';

    const result = await executeTool('create_canvas', {
      title: 'Contrat de bail',
      contract_type: 'bail-habitation',
      markdown,
    }, context);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content);
    expect(payload.unsupported_references).toContain('code civil');
    expect(events).toHaveLength(0);
  });

  it('accepte une mention présente dans les notes juridiques du modèle', async () => {
    const { events, context } = toolContext();
    // « attestation d'immatriculation fiscale » figure dans les notes du bail.
    const markdown = BAIL_COMPLET + '\n\nLe Bailleur produit une attestation d\'immatriculation fiscale.\n';

    const result = await executeTool('create_canvas', {
      title: 'Contrat de bail',
      contract_type: 'bail-habitation',
      markdown,
    }, context);

    expect(result.isError).toBe(false);
    expect(events.map((event) => event.event)).toContain('canvas_set');
  });
});

/* ------------------------------------------------------------------ */
/* P1-5 — champs obligatoires non renseignés                             */
/* ------------------------------------------------------------------ */

describe('P1-5 — les champs obligatoires non renseignés sont signalés', () => {
  const template = TemplateStore.load().get('bail-habitation')!;

  it('émet une issue par champ obligatoire laissé vide', () => {
    // Un bail où les parties et le logement sont encore des espaces réservés.
    const incomplete = [
      '# Contrat de bail à usage d\'habitation',
      '',
      '## Article 1 – Objet du contrat',
      '',
      'Le Bailleur donne à bail [À COMPLÉTER : désignation du logement].',
      '',
      '## Article 2 – Durée',
      '',
      'Le bail est conclu pour une durée de 12 mois.',
      '',
      '## Article 3 – Loyer',
      '',
      'Le loyer mensuel est fixé à 150 000 FCFA.',
      '',
    ].join('\n');

    const result = validate(incomplete, template);
    const missing = result.issues.filter((issue) => issue.code === 'required_field');
    expect(missing.length).toBeGreaterThan(0);
    for (const issue of missing) {
      expect(issue.severity).toBe('warning');
    }
    // L'identité des parties n'est pas renseignée : elle doit être signalée.
    expect(missing.map((issue) => issue.message).join(' ')).toContain('bailleur');
  });

  it('n\'émet pas d\'issue quand le champ est renseigné', () => {
    const result = validate(BAIL_COMPLET, template);
    const missing = result.issues.filter((issue) => issue.code === 'required_field');
    // BAIL_COMPLET renseigne les cinq champs obligatoires du bail.
    expect(missing).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* P1-4 — pas d'anglicisme dans un acte                                 */
/* ------------------------------------------------------------------ */

describe('P1-4 — un acte de droit ne contient pas d\'anglicisme', () => {
  it('signale les mots anglais', () => {
    const result = validate(BAIL_COMPLET + '\n\nLe prenom du locataire est signing.\n');
    const anglicism = result.issues.find((issue) => issue.code === 'anglicism');
    expect(anglicism).toBeDefined();
    expect(anglicism!.message).toContain('signing');
  });

  it('ne signale pas un bail rédigé correctement', () => {
    const result = validate(BAIL_COMPLET);
    expect(result.issues.filter((issue) => issue.code === 'anglicism')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* P2-1 — version conforme au contrat d'API                            */
/* ------------------------------------------------------------------ */

describe('P2-1 — la version du canvas_set suit le contrat d\'API', () => {
  it('vaut 1 quand get_template précède create_canvas', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          text: 'Je consulte le modèle.',
          toolUses: [{ id: 't1', name: 'get_template', input: { contract_type: 'bail-habitation' } }],
          finishReason: 'tool_calls',
        },
        {
          text: 'Je rédige.',
          toolUses: [{
            id: 't2',
            name: 'create_canvas',
            input: { title: 'Contrat', contract_type: 'bail-habitation', markdown: BAIL_COMPLET },
            partialJson: JSON.stringify({ title: 'Contrat', contract_type: 'bail-habitation', markdown: BAIL_COMPLET }),
          }],
          finishReason: 'tool_calls',
        },
        { text: 'V1 prête.' },
      ],
    });

    const app = testApp({}, { client: fakeClient(client) });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: 'Je veux un bail d habitation pour un studio a Cocody, loyer 150 000 FCFA par mois, duree 12 mois, bailleur Monsieur Koné, locataire Madame Aya.',
        }],
      }),
    });
    const events = parseSse(await res.text());
    const set = events.find((event) => event.event === 'canvas_set')!;
    // API-CONTRACT §3.3 : version = document.version (0) + canvas_set émis (0) + 1
    expect(set.data.version).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* P2-3 — l'export refuse un document non exportable                    */
/* ------------------------------------------------------------------ */

describe('P2-3 — l\'export Word refuse une construction interdite', () => {
  const app = () => testApp();

  it('refuse un document qui contient un bloc de code', async () => {
    const res = await app().request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Titre\n\n```js\nconst a = 1;\n```\n' }),
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('Word');
  });

  it('accepte un document conforme', async () => {
    const res = await app().request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: SAMPLE_BAIL }),
    });
    expect(res.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* P2-6 — authentification obligatoire en production                     */
/* ------------------------------------------------------------------ */

describe('P2-6 — la configuration refuse de démarrer sans authentification en production', () => {
  it('échoue en production sans ACCESS_CODE', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'k' })).toThrow(/ACCESS_CODE/);
  });

  it('accepte la production avec ACCESS_CODE', () => {
    const config = loadConfig({ NODE_ENV: 'production', OPENROUTER_API_KEY: 'k', ACCESS_CODE: 'secret' });
    expect(config.accessCode).toBe('secret');
  });

  it('accepte le développement sans ACCESS_CODE', () => {
    const config = loadConfig({ NODE_ENV: 'development', OPENROUTER_API_KEY: 'k' });
    expect(config.accessCode).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* P2-7 — le quota est par identité, pas par adresse IP                 */
/* ------------------------------------------------------------------ */

describe('P2-7 — deux identités distinctes ne partagent pas de quota', () => {
  beforeEach(() => resetRateLimits());

  /** Application minimale : elle fixe l'identité, puis applique le quota. */
  function appWithIdentity(identity: string | null) {
    const app = new Hono<{ Variables: { identity: string | null } }>();
    app.use('/x', async (c, next) => {
      c.set('identity', identity);
      await next();
    });
    app.use('/x', rateLimit({ name: 'ident', limit: 1, windowMs: 60_000, trustProxy: false }));
    app.get('/x', (c) => c.json({ ok: true }));
    app.onError((error, c) => c.json(
      { error: { code: (error as any).code ?? 'internal' } },
      (error as any).status ?? 500,
    ));
    return app;
  }

  it('laisse passer une requête par identité', async () => {
    const alice = await appWithIdentity('alice').request('/x');
    expect(alice.status).toBe(200);

    // Bob a son propre quota : la requête passe.
    const bob = await appWithIdentity('bob').request('/x');
    expect(bob.status).toBe(200);

    // Une seconde requête d'Alice est refusée.
    const aliceAgain = await appWithIdentity('alice').request('/x');
    expect(aliceAgain.status).toBe(429);
  });

  it('regroupe les requêtes sans identité sous un quota partagé', async () => {
    const first = await appWithIdentity(null).request('/x');
    expect(first.status).toBe(200);
    const second = await appWithIdentity(null).request('/x');
    expect(second.status).toBe(429);
  });
});

/* ------------------------------------------------------------------ */
/* S11 — en-têtes de sécurité                                            */
/* ------------------------------------------------------------------ */

describe('S11 — Content-Security-Policy et Permissions-Policy', () => {
  it('pose la CSP et la Permissions-Policy', async () => {
    const app = testApp();
    const res = await app.request('/api/health');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('permissions-policy')).toContain('geolocation=()');
  });

  it('le nonce de la page est celui de l\'en-tête CSP', async () => {
    const app = testApp();
    const res = await app.request('/');
    const served = await res.text();
    const nonce = /<script nonce="([^"]+)">/.exec(served)?.[1];
    expect(nonce).toBeTruthy();
    // Sans cette correspondance, le script inline de la page est bloqué par
    // le navigateur et l'interface ne démarre pas.
    expect(res.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
  });

  it('injecte PUBLIC_API_BASE et l’autorise dans connect-src', async () => {
    const app = testApp({ publicApiBase: 'https://api.example.com' });
    const res = await app.request('/');
    const html = await res.text();
    expect(html).toContain('API_BASE: "https://api.example.com"');
    expect(res.headers.get('content-security-policy'))
      .toContain('connect-src \'self\' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://api.example.com');
  });

  it('répond au préflight CORS depuis Firebase Hosting', async () => {
    const app = testApp({ allowedOrigins: ['https://altredige.web.app'] });
    const res = await app.request('/api/chat', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://altredige.web.app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://altredige.web.app');

    // Cross-origin export: the frontend reads Content-Disposition.
    const health = await app.request('/api/health', {
      headers: { Origin: 'https://altredige.web.app' },
    });
    expect(health.headers.get('access-control-allow-origin')).toBe('https://altredige.web.app');
    expect(health.headers.get('access-control-expose-headers')).toContain('Content-Disposition');
  });
});

/* ------------------------------------------------------------------ */
/* AGENT-PROTOCOL.md §8 — poser une question, arrêter le tour          */
/* ------------------------------------------------------------------ */

describe('AGENT-PROTOCOL — ask_user', () => {
  it('pose une question et termine le tour sur awaiting_input', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          text: 'Je pose une question.',
          toolUses: [{
            id: 'q1',
            name: 'ask_user',
            input: { question: 'Quelle durée pour le bail ?', kind: 'single', options: [{ id: '12', label: '12 mois' }] },
          }],
          finishReason: 'tool_calls',
        },
      ],
    });

    const app = testApp({}, { client: fakeClient(client) });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Je veux un bail.' }] }),
    });
    const events = parseSse(await res.text());
    const names = events.map((event) => event.event);

    expect(names).toContain('ask_user');
    // §15 : `ask_user` est toujours immédiatement suivi de `done`.
    expect(names[names.length - 1]).toBe('done');
    expect(names[names.indexOf('ask_user') + 1]).toBe('done');

    const asked = events.find((event) => event.event === 'ask_user')!;
    expect(asked.data.kind).toBe('single');
    expect(asked.data.question).toBe('Quelle durée pour le bail ?');
    expect(asked.data.options[0].label).toBe('12 mois');

    const done = events[events.length - 1]!;
    expect(done.data.stop_reason).toBe('awaiting_input');
  });

  it('enveloppe chaque événement d\'un numéro de séquence et d\'un horodatage', async () => {
    const client = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }] });
    const app = testApp({}, { client: fakeClient(client) });
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }] }),
    });
    const events = parseSse(await res.text());
    expect(events.length).toBeGreaterThan(1);
    events.forEach((event, index) => {
      expect(event.data.seq).toBe(index + 1);
      expect(typeof event.data.t).toBe('number');
    });
  });

  it('accepte les réponses structurées (answers) sans les exiger', async () => {
    const client = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }] });
    const app = testApp({}, { client: fakeClient(client) });

    const withAnswers = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Durée : 12 mois' }],
        answers: [{ question_id: 'q_duree', values: { choice: '12' } }],
      }),
    });
    expect(withAnswers.status).toBe(200);
    await withAnswers.text();

    const badAnswers = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'x' }],
        answers: [{ values: { choice: '12' } }],
      }),
    });
    expect(badAnswers.status).toBe(400);
  });
});
