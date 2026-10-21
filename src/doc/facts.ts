/**
 * Contrôle déterministe des faits : ce que le document affirme doit provenir
 * de l'utilisateur, du modèle de référence ou d'un calcul vérifiable.
 *
 * Ce contrôle ne dit rien du droit : il vérifie uniquement que le contrat
 * n'affirme pas un montant, une durée, une date ou un nom propre que
 * personne n'a fourni.
 *
 * Le contrôle est affiché comme un avertissement (`validation.issues`), il
 * ne bloque pas l'écriture : une erreur de l'utilisateur sur un nom reste
 * possible.
 */
import type { ContractTemplate } from '../templates.js';
import { normalizeKey } from './structure.js';
import { templateVocabulary } from './required-fields.js';

export interface FactProblem {
  kind: 'amount' | 'duration' | 'date' | 'name';
  value: string;
  detail: string;
}

const MONTHS = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';

const AMOUNT = /(\d[\d\s .]*)\s*(?:FCFA|XOF|francs?\s*CFA)/gi;
const DURATION = /\b(\d+)\s*(mois|an|ans|années?|jours?|semaines?|trimestres?|semestres?)\b/gi;
const DATE = new RegExp(
  `\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b|\\b\\d{1,2}\\s+(?:${MONTHS})\\b`,
  'gi',
);

/** Nombres présents dans une source de référence. */
function referenceNumbers(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/\d[\d\s .]*\d|\d/g)) {
    const digits = match[0].replace(/[\s .]/g, '');
    const value = Number(digits);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

/**
 * Un nombre est-il dérivable des nombres de référence ?
 *
 * Couvre les arithmétiques usuelles d'un contrat : total (prix × durée),
 * somme, différence, reprise d'un montant avec un multiplicateur.
 */
function isDerived(value: number, reference: number[]): boolean {
  if (reference.includes(value)) return true;

  for (const a of reference) {
    if (a === 0) continue;
    if (a === value) return true;
    for (const b of reference) {
      if (a * b === value) return true;
      if (a + b === value) return true;
      if (a - b === value) return true;
      if (b - a === value) return true;
      if (b !== 0 && Math.round((a / b) * 100) / 100 === value) return true;
    }
  }
  return false;
}

/** Retire les espaces réservés : leur contenu est par définition inconnu. */
function withoutPlaceholders(markdown: string): string {
  return markdown.replace(/\[À COMPLÉTER[^\]]*\]/g, ' ');
}

/**
 * Contrôle les faits d'un document.
 *
 * @param markdown       le document produit
 * @param userText       les messages de l'utilisateur (concaténés)
 * @param template       le modèle de référence (vocabulaire, squelette, notes)
 */
export function checkFacts(
  markdown: string,
  userText: string,
  template: ContractTemplate | null,
): FactProblem[] {
  const problems: FactProblem[] = [];
  const text = withoutPlaceholders(markdown ?? '');
  const messages = userText ?? '';

  const reference = [
    messages,
    template?.skeleton_markdown ?? '',
    ...(template?.legal_notes ?? []),
  ].join('\n');

  const numbers = referenceNumbers(reference);
  const referenceNormalized = normalizeKey(reference);

  // 1. Montants.
  for (const match of text.matchAll(AMOUNT)) {
    const digits = match[1]!.replace(/[\s .]/g, '');
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    if (isDerived(value, numbers)) continue;
    problems.push({
      kind: 'amount',
      value: match[0].trim(),
      detail: 'montant absent des informations fournies',
    });
  }

  // 2. Durées.
  for (const match of text.matchAll(DURATION)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (isDerived(value, numbers)) continue;
    problems.push({
      kind: 'duration',
      value: match[0].trim(),
      detail: 'durée absente des informations fournies',
    });
  }

  // 3. Dates.
  for (const match of text.matchAll(DATE)) {
    const parts = match[0].match(/\d+/g) ?? [];
    if (parts.length === 0) continue;
    if (parts.every((part) => referenceNormalized.includes(part))) continue;
    problems.push({
      kind: 'date',
      value: match[0].trim(),
      detail: 'date absente des informations fournies',
    });
  }

  // 4. Noms propres : mots capitalisés qui ne sont ni du vocabulaire du
  //    modèle, ni fournis par l'utilisateur.
  const vocabulary = template ? templateVocabulary(template) : new Set<string>();
  const userVocabulary = new Set<string>();
  for (const word of messages.split(/[^\p{L}\p{N}'’-]+/u)) {
    if (word.length >= 3) userVocabulary.add(normalizeKey(word));
  }

  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*>\d.)\s]+/, '');
    let atSentenceStart = true;
    for (const word of cleaned.split(/\s+/)) {
      const bare = word.replace(/[^\p{L}'’-]/gu, '');
      if (!bare) continue;
      if (atSentenceStart) {
        atSentenceStart = false;
        continue;
      }
      if (/[.:!?»”]$/.test(word)) atSentenceStart = true;
      if (bare.length < 3) continue;
      if (!/^\p{Lu}/u.test(bare)) continue;
      // Un sigle (« CDI », « SARL ») n'est pas un nom propre.
      if (/^\p{Lu}+$/u.test(bare)) continue;

      const key = normalizeKey(bare);
      if (vocabulary.has(key) || userVocabulary.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({
        kind: 'name',
        value: bare,
        detail: 'nom propre absent des informations fournies',
      });
    }
  }

  return problems;
}
