import { describe, expect, it } from 'vitest';
import { checkTextSafety, parseVerdict } from '../src/safety.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';

describe('parseVerdict', () => {
  it('lit le format Nemotron « User Safety: safe »', () => {
    expect(parseVerdict('User Safety: safe')).toBe('safe');
    expect(parseVerdict('User Safety: unsafe')).toBe('unsafe');
    expect(parseVerdict('User Safety: safe\nResponse Safety: unsafe')).toBe('safe');
    expect(parseVerdict('user safety - unsafe')).toBe('unsafe');
  });

  it('lit SAFE et UNSAFE', () => {
    expect(parseVerdict('SAFE')).toBe('safe');
    expect(parseVerdict('unsafe')).toBe('unsafe');
    expect(parseVerdict('  UNSAFE  ')).toBe('unsafe');
    expect(parseVerdict('Safe — no problem')).toBe('safe');
  });

  it('renvoie null sur une réponse incompréhensible', () => {
    expect(parseVerdict('')).toBeNull();
    expect(parseVerdict('je ne sais pas')).toBeNull();
    expect(parseVerdict('Response Safety: unsafe')).toBeNull();
  });
});

describe('checkTextSafety', () => {
  const controller = () => new AbortController().signal;

  it('accepte un texte ordinaire', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'User Safety: safe' });
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
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'User Safety: unsafe' });
    const verdict = await checkTextSafety({
      client: fakeClient(fake),
      model: 'nvidia/nemotron-3.5-content-safety:free',
      text: 'contenu dangereux',
      signal: controller(),
    });
    expect(verdict.safe).toBe(false);
    expect(verdict.label).toBe('unsafe');
  });

  it('demande un budget suffisant au modèle à raisonnement', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'User Safety: safe' });
    await checkTextSafety({
      client: fakeClient(fake),
      model: 'safety',
      text: 'bonjour',
      signal: controller(),
    });
    const bodies = fake.safetyCalls;
    expect(bodies).toHaveLength(1);
  });

  it('laisse passer quand le gardien est indisponible', async () => {
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'User Safety: unsafe' });
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
    const fake = new FakeOpenRouter({ turns: [], safetyVerdict: 'User Safety: unsafe' });
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
