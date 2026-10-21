import { describe, expect, it } from 'vitest';
import { checkTextSafety, parseVerdict } from '../src/safety.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';

describe('parseVerdict', () => {
  it('lit SAFE et UNSAFE', () => {
    expect(parseVerdict('SAFE')).toBe('safe');
    expect(parseVerdict('unsafe')).toBe('unsafe');
    expect(parseVerdict('  UNSAFE  ')).toBe('unsafe');
    expect(parseVerdict('Safe — no problem')).toBe('safe');
  });

  it('renvoie null sur une réponse incompréhensible', () => {
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict('je ne sais pas')).toBeNull();
  });
});

describe('checkTextSafety', () => {
  const controller = () => new AbortController().signal;

  it('accepte un texte ordinaire', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'SAFE' });
    const verdict = await checkTextSafety({
      client: fakeClient(fake),
      model: 'nvidia/nemotron-3.5-content-safety:free',
      text: 'Je veux un bail d’habitation.',
      signal: controller(),
    });
    expect(verdict.safe).toBe(true);
    expect(verdict.label).toBe('safe');
    expect(verdict.available).toBe(true);
  });

  it('refuse un contenu dangereux', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'UNSAFE' });
    const verdict = await checkTextSafety({
      client: fakeClient(fake),
      model: 'nvidia/nemotron-3.5-content-safety:free',
      text: 'contenu dangereux',
      signal: controller(),
    });
    expect(verdict.safe).toBe(false);
    expect(verdict.label).toBe('unsafe');
  });

  it('laisse passer quand le gardien est indisponible', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'UNSAFE' });
    // Le faux renvoie une erreur réseau si le corps n'est pas lisible : on force
    // un garde-fou indisponible en simulant une réponse illisible.
    const client = {
      ...fakeClient(fake),
      fetchImpl: (async () => new Response('pas du json', { status: 500 })) as typeof fetch,
    };
    const verdict = await checkTextSafety({
      client,
      model: 'safety',
      text: 'bonjour',
      signal: controller(),
    });
    expect(verdict.safe).toBe(true);
    expect(verdict.available).toBe(false);
  });

  it('laisse passer quand la réponse est illisible', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'peut-être' });
    const verdict = await checkTextSafety({
      client: fakeClient(fake),
      model: 'safety',
      text: 'bonjour',
      signal: controller(),
    });
    expect(verdict.safe).toBe(true);
    expect(verdict.available).toBe(false);
  });

  it('n’appelle pas le gardien pour un texte vide', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'UNSAFE' });
    const verdict = await checkTextSafety({
      client: fakeClient(fake),
      model: 'safety',
      text: '   ',
      signal: controller(),
    });
    expect(verdict.safe).toBe(true);
    expect(fake.safetyCalls).toHaveLength(0);
  });
});
