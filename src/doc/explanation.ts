/**
 * Explication pédagogique d'une clause (docs/SPEC-EXPLICATION-CLAUSES.md).
 *
 * Principes non négociables, appliqués côté serveur :
 *  1. l'explication porte sur le texte **présent** dans le document ;
 *  2. elle ne peut affirmer qu'une clause est valide, nulle ou obligatoire si
 *     le texte ne le dit pas ;
 *  3. elle ne cite un texte de loi que si ce texte figure dans les notes
 *     juridiques du modèle ;
 *  4. elle signale ce qui manque quand l'interprétation en dépend ;
 *  5. elle se termine par la mention qu'elle ne remplace pas l'avis d'un
 *     professionnel du droit.
 */
import type { ContractTemplate } from '../templates.js';
import { checkReferences } from './references.js';
import { findEnglishWords } from './lexical.js';
import { articles } from './structure.js';

export interface ClauseExplanation {
  article: string;
  /** Extrait littéral du document. */
  quote: string;
  explanation: string;
  obligations: Array<{ party: string; duty: string }>;
  risks: string[];
  /** Éléments du contrat dont la valeur change la portée. */
  depends_on: string[];
  limits: string;
  document_version: number;
}

export const EXPLANATION_LIMITS =
  'Cette explication est un aide à la lecture. Elle ne remplace pas l’avis d’un professionnel du droit, '
  + 'et ne vaut pas certification de conformité.';

/** Affirmations juridiques qu'un texte de contrat ne peut pas porter seul. */
const LEGAL_CLAIMS = [
  'est valide',
  'est nul',
  'est obligatoire',
  'est illégal',
  'est licite',
  'prime sur',
  'est définitif',
];

export interface ExplanationRequest {
  article: string;
  focus?: string;
}

/**
 * Vérifie qu'une explication respecte les règles.
 * @returns la liste des manquements (vide si tout est bon).
 */
export function checkExplanation(
  explanation: ClauseExplanation,
  document: string,
  template: ContractTemplate | null,
): string[] {
  const problems: string[] = [];

  // 1. L'extrait doit être présent caractère pour caractère.
  if (!explanation.quote || !document.includes(explanation.quote)) {
    problems.push('L’extrait cité ne figure pas dans le document.');
  }

  // 2. Aucune affirmation juridique que le texte ne porte pas.
  const body = explanation.explanation.toLowerCase();
  for (const claim of LEGAL_CLAIMS) {
    if (body.includes(claim)) {
      problems.push(`Affirmation juridique non étayée par le texte : « ${claim} ».`);
    }
  }

  // 3. Aucune citation hors du référentiel du modèle.
  const unsupported = checkReferences(explanation.explanation, template);
  for (const reference of unsupported) {
    problems.push(`Référence absente du référentiel : ${reference}.`);
  }

  // 4. Pas d'anglicisme.
  const anglicisms = findEnglishWords(explanation.explanation);
  if (anglicisms.length > 0) {
    problems.push(`Anglicisme : ${anglicisms.join(', ')}.`);
  }

  // 5. La mention de limite est obligatoire.
  if (!explanation.limits || explanation.limits.length < 20) {
    problems.push('La mention de limite est absente.');
  }

  return problems;
}

/** Retrouve l'article demandé dans le document. */
export function findArticle(document: string, wanted: string): { title: string; quote: string } | null {
  const list = articles(document);
  const needle = wanted
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  // 1. Par numéro : « 4 », « Article 4 », « l'article 4 ».
  const byNumber = /^(?:article\s+|l['’]?article\s+)?(\d+)$/.exec(needle);
  if (byNumber) {
    const number = Number(byNumber[1]);
    const found = list.find((article) => article.number === number);
    if (found) return { title: found.title, quote: found.title };
  }

  // 2. Par intitulé (comparaison souple).
  const simplified = needle.replace(/^article\s+/, '').replace(/^l['’]?article\s+/, '');
  const found = list.find((article) => {
    const label = article.label
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return label.includes(simplified) || simplified.includes(label);
  });

  return found ? { title: found.title, quote: found.title } : null;
}
