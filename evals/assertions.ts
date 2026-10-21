/**
 * Deterministic assertions of the evaluations (SPEC-BACKEND.md §8).
 * No model call here: only checks on what the server produced.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../src/doc/validate.js';
import { renderDocx, titleFromMarkdown } from '../src/export/docx.js';
import { countOccurrences, openDocx } from './docx-utils.js';

const exec = promisify(execFile);

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Normalized and compacted: only letters and digits, to compare numbers. */
export function compact(value: string): string {
  return normalize(value).replace(/[^a-z0-9]/g, '');
}

/** Splits a document into its sections (one per `## ` heading). */
export function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let current = '(préambule)';
  let buffer: string[] = [];

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      out.set(current, buffer.join('\n').trim());
      current = line.replace(/^##\s+/, '').trim();
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  out.set(current, buffer.join('\n').trim());
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. No invention                                                     */
/* ------------------------------------------------------------------ */

const MONTHS = 'janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre';

const CONTRACT_STOPLIST = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'des', 'au', 'aux', 'en', 'et', 'ou',
  'il', 'elle', 'entre', 'les', 'soussignés', 'ci-après', 'désigné', 'désignée', 'lequel',
  'laquelle', 'qui', 'que', 'dont', 'est', 'sont', 'sera', 'seront', 'peut', 'peuvent',
  'doit', 'doivent', 'par', 'pour', 'avec', 'sans', 'sur', 'sous', 'dans', 'à', 'a',
  'bailleur', 'locataire', 'bail', 'contrat', 'article', 'parties', 'partie', 'adresse',
  'nom', 'complet', 'lieu', 'date', 'durée', 'duree', 'montant', 'loyer', 'dépôt', 'depot',
  'garantie', 'préavis', 'preavis', 'jours', 'mois', 'ans', 'année', 'exemplaires',
  'originaux', 'signatures', 'signataire', ' objet', 'usage', 'habitation', 'résiliation',
  'resiliation', 'obligations', 'demeure', 'demeurant', 'y', 'en', 'effet', 'prise',
  'prix', 'charges', 'eau', 'électricité', 'electricite', 'gaz', 'taxe', 'syndic',
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'douze',
  'quatorze', 'quinze', 'vingt', 'trente', 'soixante', 'cent', 'mille',
  'obligations', 'obligation', 'approuvé', 'approuvée', 'convenu', 'arrêté',
  'modifié', 'modifiée', 'précise', 'domicilié', 'domiciliée', 'né', 'née',
  'signataire', 'signé', 'signée', 'visa', 'instances', 'exemplaire', 'présent',
]);

/**
 * Checks that every proper noun, amount or date of the contract comes either
 * from the user messages or from a `[À COMPLÉTER …]` placeholder.
 *
 * The wording of the template (skeleton and legal notes) is also accepted: the
 * model is supposed to reuse it, it is not an invention.
 */
export function checkNoInventedFacts(
  document: string,
  userMessages: string[],
  template?: { legal_notes?: string[]; skeleton_markdown?: string } | null,
): CheckResult {
  // Remove the placeholders: their content is by definition unknown.
  const withoutPlaceholders = document.replace(/\[À COMPLÉTER[^\]]*\]/g, ' ');
  const sources = [
    userMessages.join('\n'),
    template?.legal_notes?.join('\n') ?? '',
    template?.skeleton_markdown ?? '',
  ];
  const reference = normalize(sources.join('\n'));
  const compactReference = compact(sources.join('\n'));

  const problems: string[] = [];

  const amounts = withoutPlaceholders.match(/\d[\d\s .]*\s*(?:FCFA|XOF|francs? CFA)/gi) ?? [];
  for (const amount of amounts) {
    const digits = amount.match(/\d[\d\s .]*/)?.[0].replace(/[\s .]/g, '') ?? '';
    if (digits && !compactReference.includes(digits)) problems.push(`montant « ${amount.trim()} »`);
  }

  const durations = withoutPlaceholders.match(/\b\d+\s*(?:mois|ans?|années?|jours?|semaines?)\b/gi) ?? [];
  for (const duration of durations) {
    const digits = duration.match(/\d+/)?.[0] ?? '';
    if (digits && !compactReference.includes(digits)) problems.push(`durée « ${duration.trim()} »`);
  }

  const dates = withoutPlaceholders.match(
    new RegExp(`\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b|\\b\\d{1,2}\\s+(?:${MONTHS})\\b`, 'gi'),
  ) ?? [];
  for (const date of dates) {
    const numbers = date.match(/\d+/g) ?? [];
    if (numbers.length > 0 && !numbers.every((number) => compactReference.includes(number))) {
      problems.push(`date « ${date.trim()} »`);
    }
  }

  // Proper nouns: capitalized words that are not common contract words.
  const properNouns = new Set<string>();
  for (const line of withoutPlaceholders.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*\d.)\s]+/, '');
    const words = cleaned.split(/\s+/);
    words.forEach((word, index) => {
      const bare = word.replace(/[^\p{L}'’-]/gu, '');
      if (bare.length < 4) return;
      if (!/^\p{Lu}/u.test(bare)) return;
      const key = normalize(bare);
      if (CONTRACT_STOPLIST.has(key)) return;
      // The first word of a sentence is usually a common word.
      if (index === 0) return;
      if (properNouns.has(key)) return;
      properNouns.add(key);
    });
  }

  for (const noun of properNouns) {
    if (!reference.includes(noun)) problems.push(`nom « ${noun} »`);
  }

  return {
    name: 'Pas d’invention',
    ok: problems.length === 0,
    ...(problems.length ? { detail: problems.join(', ') } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 2. Targeted edit                                                    */
/* ------------------------------------------------------------------ */

/**
 * Checks that the sections of the document that were not supposed to change
 * are identical, byte for byte.
 */
export function checkUnchangedSections(
  before: string,
  after: string,
  unchanged: string[],
): CheckResult {
  const beforeSections = sections(before);
  const afterSections = sections(after);
  const problems: string[] = [];

  for (const title of unchanged) {
    const key = [...afterSections.keys()].find((name) => normalize(name).includes(normalize(title)));
    if (!key) {
      problems.push(`section « ${title} » absente du document final`);
      continue;
    }
    const oldKey = [...beforeSections.keys()].find((name) => normalize(name).includes(normalize(title)));
    const oldBody = oldKey ? beforeSections.get(oldKey)! : '';
    const newBody = afterSections.get(key)!;
    if (oldBody !== newBody) {
      problems.push(`section « ${title} » modifiée`);
    }
  }

  return {
    name: 'Édition ciblée',
    ok: problems.length === 0,
    ...(problems.length ? { detail: problems.join(', ') } : {}),
  };
}

/** Counts the sections that differ between two documents. */
export function countChangedSections(before: string, after: string): number {
  const beforeSections = sections(before);
  const afterSections = sections(after);
  let changed = 0;
  for (const [title, body] of afterSections) {
    const oldKey = [...beforeSections.keys()].find((name) => normalize(name).includes(normalize(title)));
    if (!oldKey || beforeSections.get(oldKey) !== body) changed += 1;
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* 3. No contract in the chat                                          */
/* ------------------------------------------------------------------ */

export function checkChatText(chat: string, maxLength = 600): CheckResult {
  const problems: string[] = [];
  if (chat.length > maxLength) problems.push(`${chat.length} caractères (maximum ${maxLength})`);
  if (/##\s*Article/i.test(chat)) problems.push('le chat contient un titre d’article');

  return {
    name: 'Pas de contrat dans le chat',
    ok: problems.length === 0,
    ...(problems.length ? { detail: problems.join(', ') } : {}),
  };
}

/** Counts the questions asked to the user in a turn of chat. */
export function countQuestions(chat: string): number {
  return (chat.match(/\?/g) ?? []).length;
}

/* ------------------------------------------------------------------ */
/* 4. Subset respected                                                */
/* ------------------------------------------------------------------ */

export function checkSubset(document: string): CheckResult {
  const result = validate(document);
  const forbidden = result.issues.filter((issue) => issue.code === 'forbidden_construct');
  return {
    name: 'Sous-ensemble respecté',
    ok: forbidden.length === 0,
    ...(forbidden.length ? { detail: forbidden.map((issue) => issue.message).join(', ') } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 5. Valid export                                                     */
/* ------------------------------------------------------------------ */

async function commandExists(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await exec('where', [command]);
    } else {
      await exec('which', [command]);
    }
    return true;
  } catch {
    return false;
  }
}

export interface ExportCheck extends CheckResult {
  skipped?: string[];
}

export async function checkExport(document: string, title?: string | null): Promise<ExportCheck> {
  const skipped: string[] = [];
  const problems: string[] = [];

  let buffer: Buffer;
  try {
    const result = await renderDocx(document, { footer: null });
    buffer = result.buffer;
  } catch (error) {
    return {
      name: 'Export valide',
      ok: false,
      skipped,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const archive = await openDocx(buffer);
  if (!archive.entries.includes('word/document.xml')) problems.push('archive Word incomplète');

  const expectedTitle = title ?? titleFromMarkdown(document);
  if (expectedTitle) {
    const needle = expectedTitle.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
    if (!archive.documentXml.includes(needle)) problems.push('titre absent du document Word');
  }

  const placeholderCount = countOccurrences(archive.documentXml, 'À COMPLÉTER');
  if (placeholderCount === 0 && /\[À COMPLÉTER/.test(document)) {
    problems.push('espaces réservés absents du document Word');
  }

  // Optional external checks.
  const directory = mkdtempSync(join(tmpdir(), 'lexcanvas-eval-'));
  const file = join(directory, 'contrat.docx');
  writeFileSync(file, buffer);

  try {
    if (await commandExists('pandoc')) {
      try {
        const { stdout } = await exec('pandoc', ['-t', 'plain', file]);
        if (expectedTitle && !stdout.includes(expectedTitle.replace(/'/g, '’'))) {
          const loose = stdout.replace(/[’']/g, "'");
          if (!loose.includes(expectedTitle.replace(/[’']/g, "'"))) {
            problems.push('pandoc ne retrouve pas le titre');
          }
        }
      } catch (error) {
        problems.push(`pandoc a échoué : ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      skipped.push('pandoc');
    }

    if (await commandExists('soffice')) {
      try {
        await exec('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', directory, file]);
      } catch (error) {
        problems.push(`conversion LibreOffice a échoué : ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      skipped.push('soffice');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  return {
    name: 'Export valide',
    ok: problems.length === 0,
    skipped,
    ...(problems.length ? { detail: problems.join(', ') } : {}),
  };
}
