import { describe, expect, it } from 'vitest';
import { executeTool, toolDefinitions, templatePayload } from '../src/agent/tools.js';
import type { AgentEmit, AgentEventName, AgentEventPayloads } from '../src/agent/events.js';
import { TemplateStore } from '../src/templates.js';
import { createLogger } from '../src/logger.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';
import { SAMPLE_BAIL } from './fixtures.js';

function collector() {
  const events: Array<{ event: string; data: unknown }> = [];
  const emit: AgentEmit = <K extends AgentEventName>(event: K, data: AgentEventPayloads[K]) => {
    events.push({ event, data });
  };
  return { events, emit };
}

function context(overrides: Partial<Parameters<typeof executeTool>[2]> = {}) {
  const { events, emit } = collector();
  const fake = new FakeOpenRouter({ turns: [] });
  const base = {
    workingDoc: null as string | null,
    workingDocType: null as string | null,
    templates: TemplateStore.load(),
    emit,
    nextVersion: () => 1,
    logger: createLogger('error'),
    client: fakeClient(fake),
    safetyModel: 'nvidia/nemotron-3.5-content-safety:free',
    safetyEnabled: false,
    signal: new AbortController().signal,
  };
  return { events, context: { ...base, ...overrides } };
}

describe('outils — définitions', () => {
  it('expose les trois outils', () => {
    const tools = toolDefinitions(TemplateStore.load());
    expect(tools.map((tool) => tool.name)).toEqual(['get_template', 'create_canvas', 'edit_canvas']);
  });

  it('restreint get_template aux modèles disponibles', () => {
    const tools = toolDefinitions(TemplateStore.load());
    const getTemplate = tools.find((tool) => tool.name === 'get_template')!;
    expect(JSON.stringify(getTemplate.parameters)).toContain('bail-habitation');
  });

  it('décrit les schémas au format JSON Schema', () => {
    const tools = toolDefinitions(TemplateStore.load());
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object');
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });
});

describe('outil get_template', () => {
  it('renvoie le squelette et les champs', async () => {
    const { events, context: ctx } = context();
    const result = await executeTool('get_template', { contract_type: 'bail-habitation' }, ctx);
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content);
    expect(payload.label).toBe("Bail d'habitation");
    expect(payload.skeleton_markdown).toContain('# Contrat de bail');
    expect(payload.legal_notes).toEqual([]);
    expect(events.map((event) => event.event)).toContain('status');
  });

  it('refuse un type inconnu et liste les types valides', async () => {
    const { context: ctx } = context();
    const result = await executeTool('get_template', { contract_type: 'promesse' }, ctx);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content);
    expect(payload.error).toContain('inconnu');
    expect(payload.valid_contract_types).toEqual(['bail-habitation']);
  });
});

describe('outil create_canvas', () => {
  it('écrit le document et émet canvas_set', async () => {
    const { events, context: ctx } = context();
    const result = await executeTool('create_canvas', {
      title: 'Contrat de bail',
      contract_type: 'bail-habitation',
      markdown: SAMPLE_BAIL,
    }, ctx);
    expect(result.isError).toBe(false);
    expect(ctx.workingDoc).toBe(SAMPLE_BAIL);
    const set = events.find((event) => event.event === 'canvas_set')!;
    expect((set.data as any).mode).toBe('create');
    expect((set.data as any).validation.placeholders).toBe(8);
  });

  it('refuse d’écraser un document sans replace', async () => {
    const { context: ctx } = context({ workingDoc: '# Ancien' });
    const result = await executeTool('create_canvas', {
      title: 'T',
      contract_type: 'bail-habitation',
      markdown: SAMPLE_BAIL,
    }, ctx);
    expect(result.isError).toBe(true);
    expect(ctx.workingDoc).toBe('# Ancien');
  });

  it('écrase avec replace=true', async () => {
    const { context: ctx } = context({ workingDoc: '# Ancien' });
    const result = await executeTool('create_canvas', {
      title: 'T',
      contract_type: 'bail-habitation',
      markdown: SAMPLE_BAIL,
      replace: true,
    }, ctx);
    expect(result.isError).toBe(false);
    expect(ctx.workingDoc).toBe(SAMPLE_BAIL);
  });

  it('refuse un contrat vide', async () => {
    const { context: ctx } = context();
    const result = await executeTool('create_canvas', { title: 'T', contract_type: 'bail-habitation', markdown: '  ' }, ctx);
    expect(result.isError).toBe(true);
  });
});

describe('outil edit_canvas', () => {
  it('applique une modification et émet canvas_start puis canvas_set', async () => {
    const { events, context: ctx } = context({ workingDoc: SAMPLE_BAIL, workingDocType: 'bail-habitation' });
    const result = await executeTool('edit_canvas', {
      edits: [{ old_str: '[À COMPLÉTER : durée du préavis]', new_str: 'trois (3) mois' }],
    }, ctx);
    expect(result.isError).toBe(false);
    expect(events.map((event) => event.event)).toEqual(['canvas_start', 'canvas_set']);
    const set = events[1]!.data as any;
    expect(set.mode).toBe('edit');
    expect(set.edits_applied).toBe(1);
    expect(set.markdown).toContain('trois (3) mois');
  });

  it('ne change rien quand l’édition échoue', async () => {
    const { events, context: ctx } = context({ workingDoc: SAMPLE_BAIL });
    const result = await executeTool('edit_canvas', { edits: [{ old_str: 'absent', new_str: 'x' }] }, ctx);
    expect(result.isError).toBe(true);
    expect(ctx.workingDoc).toBe(SAMPLE_BAIL);
    expect(events).toHaveLength(0);
  });

  it('refuse quand il n’y a pas de document', async () => {
    const { context: ctx } = context({ workingDoc: null });
    const result = await executeTool('edit_canvas', { edits: [{ old_str: 'x', new_str: 'y' }] }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).code).toBe('no_document');
  });
});

describe('outil inconnu', () => {
  it('renvoie une erreur', async () => {
    const { context: ctx } = context();
    const result = await executeTool('mystere', {}, ctx);
    expect(result.isError).toBe(true);
  });
});

describe('templatePayload', () => {
  it('n’expose pas les squelettes internes', () => {
    const template = TemplateStore.load().get('bail-habitation')!;
    const payload = templatePayload(template);
    expect(Object.keys(payload).sort()).toEqual([
      'id', 'label', 'legal_notes', 'optional_fields', 'required_fields', 'skeleton_markdown',
    ]);
  });
});
