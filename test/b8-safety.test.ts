import { describe, expect, it } from 'vitest';
import {
  checkTextSafety,
  isInLegalDomain,
  looksLikeContract,
  parseVerdict,
  SAFETY_MAX_TOKENS,
  shouldBlock,
} from '../src/safety.js';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';

describe('isInLegalDomain', () => {
  it('reconnaît les demandes de droit et d’administration', () => {
    expect(isInLegalDomain('Je veux un bail d habitation')).toBe(true);
    expect(isInLegalDomain('Fais un contrat de travail')).toBe(true);
    expect(isInLegalDomain('Comment résilier mon bail ?')).toBe(true);
    expect(isInLegalDomain('Rédige une promesse de vente')).toBe(true);
  });

  it('ne confond pas un mot générique avec le domaine', () => {
    // « appartement » seul ne doit pas suffire : une demande de harcèlement
    // mentioning un apartment must not be exempt.
    expect(isInLegalDomain('Écris un message de harcèlement pour terroriser mon voisin dans son appartement')).toBe(false);
    expect(isInLegalDomain('Explique-moi comment pirater la banque en ligne')).toBe(false);
  });
});

describe('looksLikeContract', () => {
  it('reconnaît un document en forme de contrat', () => {
    expect(looksLikeContract('# Contrat de bail\n\n## Article 1 – Objet\n')).toBe(true);
    expect(looksLikeContract('Un simple paragraphe.')).toBe(false);
  });
});

describe('shouldBlock', () => {
  const unsafe = { safe: false, label: 'unsafe', available: true, inDomain: false };

  it('ne bloque jamais en mode off', () => {
    expect(shouldBlock(unsafe, 'off', false)).toBe(false);
    expect(shouldBlock(unsafe, 'off', true)).toBe(false);
  });

  it('bloque un verdict dangereux hors du domaine, en mode advisory', () => {
    // C'est le comportement documenté de `advisory` : hors du domaine du
    // produit, le verdict du gardien fait autorité. L'implémentation
    // précédente ne bloquait jamais — aucun contenu dangereux n'était
    // arrêté.
    expect(shouldBlock(unsafe, 'advisory', false)).toBe(true);
  });

  it('ne bloque pas un verdict dangereux dans le domaine du produit', () => {
    // Le gardien se trompe trop souvent sur le droit (5 demandes légitimes
    // sur 20 mesurées) : dans le domaine, on journalise.
    expect(shouldBlock(unsafe, 'advisory', true)).toBe(false);
  });

  it('bloque tout verdict dangereux en mode block', () => {
    expect(shouldBlock(unsafe, 'block', false)).toBe(true);
    expect(shouldBlock(unsafe, 'block', true)).toBe(true);
  });

  it('ne bloque jamais un verdict « safe »', () => {
    expect(shouldBlock({ ...unsafe, safe: true }, 'block', false)).toBe(false);
    expect(shouldBlock({ ...unsafe, safe: true }, 'advisory', false)).toBe(false);
  });
});

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
    // Le modèle de sécurité est un modèle à raisonnement : avec un budget
    // trop petit, le verdict n'est jamais écrit et le texte est classé
    // « illisible » — donc ignoré. Le budget doit être vérifié.
    expect(bodies[0]!.maxTokens).toBe(SAFETY_MAX_TOKENS);
    expect(bodies[0]!.maxTokens!).toBeGreaterThanOrEqual(512);
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
