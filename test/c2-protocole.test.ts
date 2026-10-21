import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';
import { FakeOpenRouter, fakeClient, parseSse, type FakeTurn } from './fake-llm.js';
import { findEnglishWords } from '../src/doc/lexical.js';

const COMPLETE_REQUEST =
  'Je veux un bail d habitation pour un studio a Yopougon (Abidjan), loyer 70 000 FCFA par mois, '
  + 'duree 12 mois. Le bailleur est Monsieur Kone et la locataire est Madame Aya.';

const CONTRACT = [
  '# Contrat de bail à usage d\'habitation',
  '',
  '## Article 1 – Objet du contrat',
  '',
  'Le Bailleur donne à bail un studio situé à Yopougon, Abidjan.',
  '',
].join('\n');

async function runTurn(turns: FakeTurn[], userText = COMPLETE_REQUEST) {
  const client = new FakeOpenRouter({ turns });
  const app = testApp({}, { client: fakeClient(client) });
  const res = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: userText }] }),
  });
  return parseSse(await res.text());
}

describe('C2 — protocole agent : progression visible', () => {
  it('émet phase, plan et step pendant la rédaction', async () => {
    const events = await runTurn([
      {
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'Contrat de bail', contract_type: 'bail-habitation', markdown: CONTRACT },
        }],
        finishReason: 'tool_calls',
      },
      { text: 'Le bail est prêt.' },
    ]);

    const names = events.map((event) => event.event);
    expect(names).toContain('phase');
    expect(names).toContain('plan');
    expect(names).toContain('step');

    const phase = events.find((event) => event.event === 'phase')!;
    expect(phase.data.phase).toBe('understanding');
    expect(typeof phase.data.label).toBe('string');
    expect(phase.data.label.length).toBeLessThanOrEqual(80);
    // Les libellés sont en français : aucun anglicisme.
    expect(findEnglishWords(phase.data.label)).toEqual([]);

    const plan = events.find((event) => event.event === 'plan')!;
    expect(Array.isArray(plan.data.steps)).toBe(true);
    expect(plan.data.steps.length).toBeGreaterThan(0);
    expect(plan.data.steps.length).toBeLessThanOrEqual(8);

    const steps = events.filter((event) => event.event === 'step');
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(['running', 'done', 'failed', 'skipped']).toContain(step.data.state);
    }
  });

  it('émet tool_start et tool_end pour chaque outil', async () => {
    const events = await runTurn([
      {
        toolUses: [{
          id: 'tool_1',
          name: 'get_template',
          input: { contract_type: 'bail-habitation' },
        }],
        finishReason: 'tool_calls',
      },
      {
        toolUses: [{
          id: 'tool_2',
          name: 'create_canvas',
          input: { title: 'Contrat de bail', contract_type: 'bail-habitation', markdown: CONTRACT },
        }],
        finishReason: 'tool_calls',
      },
      { text: 'Le bail est prêt.' },
    ]);

    const starts = events.filter((event) => event.event === 'tool_start');
    const ends = events.filter((event) => event.event === 'tool_end');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(ends.length).toBe(starts.length);

    for (const start of starts) {
      expect(typeof start.data.label).toBe('string');
      expect(start.data.label.length).toBeGreaterThan(0);
      expect(start.data.label.length).toBeLessThanOrEqual(80);
      expect(start.data.id).toBeTruthy();
    }

    for (const end of ends) {
      expect(typeof end.data.ok).toBe('boolean');
      expect(typeof end.data.duration_ms).toBe('number');
    }

    // L'ordre est respecté : start avant end, pour le même identifiant.
    const firstStart = starts[0]!.data.id;
    const firstEnd = ends.find((end) => end.data.id === firstStart)!;
    expect(events.indexOf(starts[0]!)).toBeLessThan(events.indexOf(firstEnd));
  });

  it('n’expose jamais les arguments bruts d’un outil', async () => {
    const events = await runTurn([
      {
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'Contrat de bail', contract_type: 'bail-habitation', markdown: CONTRACT },
        }],
        finishReason: 'tool_calls',
      },
      { text: 'Le bail est prêt.' },
    ]);

    for (const event of events.filter((e) => e.event === 'tool_start' || e.event === 'tool_end')) {
      const text = JSON.stringify(event.data);
      expect(text).not.toContain('À COMPLÉTER');
      expect(text).not.toContain('markdown');
    }
  });

  it('émet sources et suggestions avant done', async () => {
    const events = await runTurn([
      {
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'Contrat de bail', contract_type: 'bail-habitation', markdown: CONTRACT },
        }],
        finishReason: 'tool_calls',
      },
      { text: 'Le bail est prêt.' },
    ]);

    const names = events.map((event) => event.event);
    const doneIndex = names.indexOf('done');
    expect(doneIndex).toBeGreaterThan(-1);

    const sources = events.find((event) => event.event === 'sources');
    expect(sources).toBeDefined();
    expect(sources!.data.items.length).toBeGreaterThan(0);
    for (const item of sources!.data.items) {
      expect(['law', 'template', 'user']).toContain(item.kind);
      expect(item.title.length).toBeGreaterThan(0);
    }

    const suggestions = events.find((event) => event.event === 'suggestions');
    expect(suggestions).toBeDefined();
    expect(suggestions!.data.items.length).toBeGreaterThanOrEqual(2);
    expect(suggestions!.data.items.length).toBeLessThanOrEqual(4);
    for (const item of suggestions!.data.items) {
      expect(typeof item.label).toBe('string');
      expect(typeof item.message).toBe('string');
    }

    expect(names.indexOf('sources')).toBeLessThan(doneIndex);
    expect(names.indexOf('suggestions')).toBeLessThan(doneIndex);
  });

  it('chaque événement porte seq et t', async () => {
    const events = await runTurn([{ text: 'Bonjour.' }]);
    let previous = 0;
    for (const event of events) {
      expect(typeof event.data.seq).toBe('number');
      expect(event.data.seq).toBeGreaterThan(previous);
      previous = event.data.seq;
      expect(typeof event.data.t).toBe('number');
    }
  });
});
