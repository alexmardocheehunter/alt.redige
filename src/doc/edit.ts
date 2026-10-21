/**
 * Atomic application of targeted edits to the contract document.
 *
 * Rules (SPEC-BACKEND.md §5):
 *  - all or nothing: if one edit fails, nothing is applied;
 *  - `old_str` must be present exactly once, compared byte for byte
 *    (no normalisation: the model copies the text as it is in the document);
 *  - edits are applied in order, each one on the result of the previous one.
 */

export interface Edit {
  old_str: string;
  new_str: string;
}

export type EditErrorCode = 'no_document' | 'not_found' | 'not_unique' | 'invalid';

export interface EditSuccess {
  ok: true;
  markdown: string;
  editsApplied: number;
}

export interface EditFailure {
  ok: false;
  code: EditErrorCode;
  /** Exploitable by the model, in French. */
  message: string;
  /** Index of the failing edit, zero-based. */
  index: number;
  /** Context that helps the model fix its `old_str`. */
  hint?: string;
}

export type EditResult = EditSuccess | EditFailure;

/** Lowercase, without diacritics — used only to find a helpful hint. */
function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const PREVIEW_LENGTH = 80;
/** Minimum similarity to propose a line as a hint. */
const MIN_HINT_SCORE = 0.35;

function preview(value: string): string {
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH)}…` : value;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Finds the line of the document that looks the closest to `old_str`.
 * Purely a hint: the comparison itself stays exact.
 */
export function closestLine(document: string, oldStr: string): string | undefined {
  const target = normalizeText(oldStr);
  if (!target) return undefined;

  const targetWords = new Set(target.split(/\s+/).filter((word) => word.length > 2));
  let best: { line: string; score: number } | undefined;

  for (const line of document.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = normalizeText(trimmed);
    const lineWords = new Set(normalized.split(/\s+/).filter((word) => word.length > 2));

    let shared = 0;
    for (const word of targetWords) {
      if (lineWords.has(word)) shared += 1;
    }
    const containment = targetWords.size > 0 ? shared / targetWords.size : 0;
    const similarity = charSimilarity(target, normalized);

    const score = containment * 0.6 + similarity * 0.4;
    if (score >= MIN_HINT_SCORE && (!best || score > best.score)) best = { line: trimmed, score };
  }

  return best?.line;
}

/** Levenshtein-based similarity, in [0, 1]. */
function charSimilarity(a: string, b: string): number {
  const left = a.slice(0, 160);
  const right = b.slice(0, 160);
  if (!left.length || !right.length) return 0;

  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j]!;
  }

  const distance = previous[right.length]!;
  return 1 - distance / Math.max(left.length, right.length);
}

/**
 * Applies the edits to a copy of the document.
 * Nothing is mutated on failure.
 */
export function applyEdits(document: string | null | undefined, edits: Edit[]): EditResult {
  if (document === null || document === undefined) {
    return {
      ok: false,
      code: 'no_document',
      index: 0,
      message: 'Aucun document à modifier : le Canvas est vide. Réponds d’abord à l’utilisateur.',
    };
  }

  if (!Array.isArray(edits) || edits.length === 0) {
    return {
      ok: false,
      code: 'invalid',
      index: 0,
      message: 'Aucun changement demandé.',
    };
  }

  let working = document;

  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index]!;

    if (typeof edit?.old_str !== 'string' || edit.old_str.length === 0) {
      return {
        ok: false,
        code: 'invalid',
        index,
        message: `Modification ${index + 1} : « old_str » est vide.`,
      };
    }

    const occurrences = countOccurrences(working, edit.old_str);

    if (occurrences === 0) {
      const hint = closestLine(working, edit.old_str);
      return {
        ok: false,
        code: 'not_found',
        index,
        message:
          `Modification ${index + 1} : le texte à remplacer est introuvable dans le document courant ` +
          `(80 premiers caractères : « ${preview(edit.old_str)} »). ` +
          `Relis le document courant et recopie exactement la phrase à remplacer, ` +
          `y compris les espaces, les guillemets « » et les accents.`,
        ...(hint ? { hint: `Ligne la plus proche : « ${preview(hint)} »` } : {}),
      };
    }

    if (occurrences > 1) {
      return {
        ok: false,
        code: 'not_unique',
        index,
        message:
          `Modification ${index + 1} : le texte à remplacer apparaît ${occurrences} fois dans le document courant. ` +
          `Ajoute quelques caractères pour le rendre unique.`,
      };
    }

    const position = working.indexOf(edit.old_str);
    working = working.slice(0, position) + (edit.new_str ?? '') + working.slice(position + edit.old_str.length);
  }

  return { ok: true, markdown: working, editsApplied: edits.length };
}
