import { describe, expect, it } from 'vitest';
import { TemplateStore, loadTemplates } from '../src/templates.js';
import { buildSystemPrompt, buildUserContext, CATALOGUE_MARKER, resetPromptCache } from '../src/agent/prompt.js';
import { testApp, readJson } from './helpers.js';

describe('B3 — modèles', () => {
  it('charge le modèle bail-habitation depuis data/templates', () => {
    const templates = loadTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]!.id).toBe('bail-habitation');
    expect(templates[0]!.status).toBe('ready');
    expect(templates[0]!.legal_notes).toEqual([]);
    expect(templates[0]!.validators).toEqual([]);
  });

  it('expose un résumé pour le frontend', () => {
    const store = TemplateStore.load();
    expect(store.summaries()).toEqual([
      {
        id: 'bail-habitation',
        label: "Bail d'habitation",
        description: "Location d'un logement à usage d'habitation",
        status: 'ready',
      },
    ]);
  });

  it('rejette un modèle invalide', () => {
    expect(() => loadTemplates('data/does-not-exist')).toThrow();
  });
});

describe('B3 — prompt', () => {
  it('remplace le marqueur du catalogue', () => {
    resetPromptCache();
    const store = TemplateStore.load();
    const prompt = buildSystemPrompt(store);
    expect(prompt).not.toContain(CATALOGUE_MARKER);
    expect(prompt).toContain('- bail-habitation — Bail d\'habitation — Location d\'un logement à usage d\'habitation');
  });

  it('injecte le document courant dans le dernier message', () => {
    const context = buildUserContext({
      document: { markdown: '# Titre\n\nTexte.', version: 3 },
      contractType: 'bail-habitation',
      userText: 'Change le préavis.',
    });
    expect(context).toContain('<document_courant version="3">');
    expect(context).toContain('# Titre');
    expect(context).toContain('Type choisi par l\'utilisateur : bail-habitation');
    expect(context).toContain('Change le préavis.');
  });

  it('signale l’absence de document', () => {
    const context = buildUserContext({ document: null, contractType: null, userText: 'Bonjour' });
    expect(context).toContain('<document_courant>(aucun document)</document_courant>');
    expect(context).toContain('Bonjour');
  });
});

describe('B3 — endpoint /api/templates', () => {
  it('liste les modèles', async () => {
    const app = testApp();
    const res = await app.request('/api/templates');
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0].id).toBe('bail-habitation');
    expect(body.templates[0].status).toBe('ready');
  });
});
