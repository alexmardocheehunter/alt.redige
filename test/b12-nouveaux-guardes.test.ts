import { describe, expect, it } from 'vitest';
import { checkExplanation, findArticle, EXPLANATION_LIMITS } from '../src/doc/explanation.js';
import { ChatGuard, isContractLike } from '../src/agent/chat-guard.js';
import { findLegalCitations, containsLoose, foldPunctuation } from '../evals/assertions.js';
import { TemplateStore } from '../src/templates.js';

const CONTRACT = `# Contrat de bail

## Article 1 – Objet du contrat

Le Bailleur donne à bail un studio.

## Article 2 – Résiliation

Chaque partie peut résilier selon l'article 1.
`;

describe('Garde-fou du chat', () => {
  it('détecte un contrat', () => {
    expect(isContractLike('## Article 1 – Objet\n\nLe Bailleur donne à bail.')).toBe(true);
    expect(isContractLike('Entre les soussignés : Monsieur Koné et Madame Aya')).toBe(true);
    expect(isContractLike('Le contrat est prêt.')).toBe(false);
    expect(isContractLike('Voici le bail que vous avez demandé, il est prêt.')).toBe(false);
  });

  it('relaye le texte normal', () => {
    const guard = new ChatGuard();
    expect(guard.filter('Le contrat ')).toBe('Le contrat ');
    expect(guard.filter('est prêt.')).toBe('est prêt.');
    expect(guard.tripped).toBe(false);
  });

  it('bloque un texte qui devient un contrat', () => {
    const guard = new ChatGuard();
    expect(guard.filter('Voici le contrat :')).toBe('Voici le contrat :');
    expect(guard.filter('## Article 1 – Objet\n\nLe Bailleur donne à bail.')).toBeNull();
    expect(guard.tripped).toBe(true);
    // Plus rien ne passe ensuite.
    expect(guard.filter('et la suite du contrat')).toBeNull();
  });

  it('écourte un texte trop long', () => {
    const guard = new ChatGuard(600);
    const long = 'x'.repeat(400);
    expect(guard.filter(long)).toBe(long);
    expect(guard.filter('y'.repeat(400))).toHaveLength(200);
    expect(guard.truncated).toBe(true);
    expect(guard.relayedLength).toBe(600);
    // Plus rien ne passe.
    expect(guard.filter('z')).toBeNull();
  });
});

describe('Explication de clause', () => {
  const template = TemplateStore.load().get('bail-habitation')!;

  it('retrouve un article par son numéro', () => {
    expect(findArticle(CONTRACT, '2')?.title).toBe('Article 2 – Résiliation');
    expect(findArticle(CONTRACT, "l'article 2")?.title).toBe('Article 2 – Résiliation');
    expect(findArticle(CONTRACT, 'Article 1')?.title).toBe('Article 1 – Objet du contrat');
  });

  it('retrouve un article par son intitulé', () => {
    expect(findArticle(CONTRACT, 'Résiliation')?.title).toBe('Article 2 – Résiliation');
  });

  it('ne retrouve pas un article absent', () => {
    expect(findArticle(CONTRACT, 'Article 9')).toBeNull();
    expect(findArticle(CONTRACT, 'inexistant')).toBeNull();
  });

  it('refuse une explication dont l’extrait n’est pas dans le document', () => {
    const problems = checkExplanation({
      article: 'Article 2 – Résiliation',
      quote: 'une phrase qui n existe pas',
      explanation: 'Chaque partie peut résilier le bail.',
      obligations: [],
      risks: [],
      depends_on: [],
      limits: EXPLANATION_LIMITS,
      document_version: 1,
    }, CONTRACT, template);
    expect(problems.join(' ')).toMatch(/extrait/);
  });

  it('refuse une affirmation juridique non étayée', () => {
    const problems = checkExplanation({
      article: 'Article 2 – Résiliation',
      quote: 'Chaque partie peut résilier',
      explanation: 'Cette clause est nulle en droit ivoirien.',
      obligations: [],
      risks: [],
      depends_on: [],
      limits: EXPLANATION_LIMITS,
      document_version: 1,
    }, CONTRACT, template);
    expect(problems.join(' ')).toMatch(/affirmation/i);
  });

  it('refuse une explication sans mention de limite', () => {
    const problems = checkExplanation({
      article: 'Article 2 – Résiliation',
      quote: 'Chaque partie peut résilier',
      explanation: 'Chaque partie peut résilier le bail.',
      obligations: [],
      risks: [],
      depends_on: [],
      limits: '',
      document_version: 1,
    }, CONTRACT, template);
    expect(problems.join(' ')).toMatch(/limite/);
  });

  it('accepte une explication conforme', () => {
    const problems = checkExplanation({
      article: 'Article 2 – Résiliation',
      quote: 'Chaque partie peut résilier',
      explanation: 'Le texte prévoit que chaque partie peut résilier le bail.',
      obligations: [{ party: 'chaque partie', duty: 'résilier' }],
      risks: [],
      depends_on: [],
      limits: EXPLANATION_LIMITS,
      document_version: 1,
    }, CONTRACT, template);
    expect(problems).toEqual([]);
  });
});

describe('Citations : renvoi interne ou citation', () => {
  it('ne confond pas un renvoi interne et une citation', () => {
    // Renvoi interne : le contrat parle de son propre article 1.
    expect(findLegalCitations('comme prévu à l\'article 1 du présent contrat', 2)).toEqual([]);
    // Citation : le texte vise un texte extérieur.
    expect(findLegalCitations('conformément à l\'article 169 bis du CGI', 2).length).toBe(1);
    expect(findLegalCitations('la loi n° 77-995', 2).length).toBe(1);
    // Renvoi vers un article inexistant : c'est une invention.
    expect(findLegalCitations('selon l\'article 12', 2).length).toBe(1);
  });
});

describe('Comparaisons tolérantes', () => {
  it('tolère le format des nombres', () => {
    expect(containsLoose('Le loyer est de 90 000 FCFA.', '90 000 FCFA')).toBe(true);
    expect(containsLoose('Le loyer est de 90.000 FCFA.', '90 000 FCFA')).toBe(true);
    expect(containsLoose('Le loyer est de 90 000,00 FCFA.', '90 000 FCFA')).toBe(true);
    expect(containsLoose('Le loyer est de 80 000 FCFA.', '90 000 FCFA')).toBe(false);
  });

  it('neutralise les apostrophes typographiques', () => {
    expect(foldPunctuation('bail d’habitation')).toBe("bail d'habitation");
    expect(foldPunctuation("bail d'habitation")).toBe("bail d'habitation");
  });
});
