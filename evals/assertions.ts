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
import { articles } from '../src/doc/structure.js';
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
  'il', 'elle', 'entre', 'soussignés', 'ci-après', 'désigné', 'désignée', 'lequel',
  'laquelle', 'qui', 'que', 'dont', 'est', 'sont', 'sera', 'seront', 'peut', 'peuvent',
  'doit', 'doivent', 'par', 'pour', 'avec', 'sans', 'sur', 'sous', 'dans', 'à', 'a',
  'bailleur', 'locataire', 'bail', 'contrat', 'article', 'parties', 'partie', 'adresse',
  'nom', 'complet', 'lieu', 'date', 'durée', 'duree', 'montant', 'loyer', 'dépôt', 'depot',
  'garantie', 'préavis', 'preavis', 'jours', 'mois', 'ans', 'année', 'exemplaires',
  'originaux', 'signatures', 'signataire', 'objet', 'usage', 'habitation', 'résiliation',
  'resiliation', 'obligations', 'demeure', 'demeurant', 'y', 'effet', 'prise',
  'prix', 'charges', 'eau', 'électricité', 'electricite', 'gaz', 'taxe', 'syndic',
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'douze',
  'quatorze', 'quinze', 'vingt', 'trente', 'soixante', 'cent', 'mille',
  'obligations', 'obligation', 'approuvé', 'approuvée', 'convenu', 'arrêté',
  'modifié', 'modifiée', 'précise', 'domicilié', 'domiciliée', 'né', 'née',
  'signataire', 'signé', 'signée', 'visa', 'instances', 'exemplaire', 'présent',
  // Vocabulaire juridique et administratif courant : ces mots capitalized
  // dans le document ne sont pas des noms inventés.
  'bien', 'aucun', 'aucune', 'toute', 'toutes', 'tout', 'tous', 'toutes', 'tels',
  'telles', 'restitution', 'restituer', 'dispositions', 'disposition', 'clause', 'clauses',
  'peine', 'amende', 'pénalité', 'pénalités', 'indemnité', 'indemnités', 'réparation',
  'dommages', 'intérêts', 'exécution', 'exécuteur', 'résiliation', 'reconduction',
  'préavis', 'demeure', 'délai', 'délais', 'suspension', 'cession', 'sous-location',
  'assurance', 'assurances', 'règlement', 'règlements', 'paiement', 'paiements',
  'modalités', 'modalité', 'remise', 'remises', 'inventaire', 'état', 'états', 'réparations',
  'visite', 'visites', 'accès', 'usage', 'usages', 'destination', 'surfaces', 'surface',
  'reconstitution', 'réparation', 'frais', 'charges', 'budget', 'prefinancement',
]);

/** Mots quiNe sont pas des inventions même capitalisés (début de phrase). */
const SENTENCE_STARTERS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'en', 'et', 'ou', 'il',
  'elle', 'ils', 'elles', 'on', 'qui', 'que', 'dont', 'si', 'ne', 'ni', 'ce', 'cet', 'cette',
  'ces', 'chaque', 'toute', 'toutes', 'tout', 'tous', 'aucun', 'aucune', 'bien', 'par',
  'pour', 'avec', 'sans', 'dans', 'sur', 'sous', 'à', 'a', 'entre', 'après', 'avant',
  'lorsque', 'dès', 'selon', 'conformément', 'à compter', 'lundi', 'mardi', 'mercredi',
  'jeudi', 'vendredi', 'samedi', 'dimanche',
]);

/**
 * Zone où un nom propre peut apparaître : l'identité des parties (avant le
 * premier article) et les lignes qui portent un titre de civilité ou une
 * forme de société. Le reste du document est du vocabulaire juridique : un
 * mot capitalisé qui y figure (« Préambule », « Réparations », « Contestations »)
 * n'est pas une invention.
 */
const IDENTITY_TITLES = [
  'monsieur', 'madame', 'm.', 'mme', 'mlle', 'maitre', 'societe', 'sarl', 's.a.',
  'sa ', 'sasu', 'sprl', 'gbie', 'entreprise', 'groupe', 'agent',
];

function identityScope(document: string): string {
  const lines = document.split(/\r?\n/);
  const firstArticle = lines.findIndex((line) => /^##\s/.test(line));
  const inHead = firstArticle === -1 ? lines.length : firstArticle;

  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    const normalized = normalize(line);
    const hasTitle = IDENTITY_TITLES.some((title) => normalized.includes(title));
    if (index < inHead || hasTitle) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Mentions d'un texte juridique dans un texte.
 *
 * Distingue :
 *  - une **citation** : « l'article 169 bis du CGI », « la loi n° 77-995 » ;
 *  - un **renvoi interne** : « l'article 3 » du contrat lui-même, qui ne
 *    cite aucun texte et ne peut donc pas être une invention.
 *
 * Le test porte sur les citations seules : sans cette distinction, tout
 * contrat numéroté — donc tout contrat — échouerait.
 */
export function findLegalCitations(text: string, articleCount = 0): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };

  // 1. Un numéro d'article suivi d'une source (« du CGI », « de la loi »…).
  const sourceAfter = /\b(du|de\s+la|de\s+l'|des|dans\s+la)\s+(code|cgi|loi|d[ée]cret|ordonnance|acte\s+uniforme|ohada|syscohada|cour|tribunal|jurisprudence|convention\s+collective|anm|cps|cnps|passage)\b/i;

  for (const match of text.matchAll(/\barticles?\s+(\d+[\s\w-]*)/gi)) {
    const end = match.index! + match[0].length;
    const tail = text.slice(end, end + 70);
    if (sourceAfter.test(tail)) push(match[0]);
  }

  // 2. Les lois, ordonnances et décrets numérotés.
  for (const match of text.matchAll(/\b(loi|ordonnance|d[ée]cret|arr[êe]t[ée])\s+n\s*[°o]?\s*([\d][\d\w./-]*)/gi)) {
    push(`${match[1]} n° ${match[2]}`);
  }

  // 3. Les renvois internes pointant vers un article inexistant : le modèle a
  //    inventé une référence.
  if (articleCount > 0) {
    for (const match of text.matchAll(/\barticles?\s+(\d+)\b/gi)) {
      if (Number(match[1]) > articleCount) push(match[0]);
    }
  }

  return out;
}

/**
 * Articles obligatoires du modèle de référence, absents du document produit.
 *
 * Le contrôle remplace l'ancien « l'agent a appelé `get_template` » : depuis
 * que le modèle de contrat est épinglé dans le contexte, l'appel n'a plus
 * lieu — mais le document produit doit toujours en reprendre les articles.
 * La comparaison se fait sur les intitulés, sans tenir compte du
 * numérotage (le serveur renumérote).
 */
export function checkRequiredArticles(
  document: string,
  required: string[],
): string[] {
  const labels = articles(document).map((article) => normalize(article.label));
  const missing: string[] = [];

  for (const wanted of required) {
    const needle = normalize(wanted);
    if (!needle) continue;
    const found = labels.some((label) => label.includes(needle) || needle.includes(label));
    if (!found) missing.push(wanted);
  }

  return missing;
}

/**
 * Checks that every proper noun, amount or date of the contract comes either
 * from the user messages or from a `[À COMPLÉTER …]` placeholder.
 *
 * The wording of the template (skeleton and legal notes) is also accepted: the
 * model is supposed to reuse it, it is not an invention.
 *
 * The proper nouns are only looked for in the **identity block** of the
 * parties (before the first article, plus the lines carrying a title of
 * courtesy): the rest of the document is legal vocabulary, where a capitalised
 * word proves nothing.
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

  // Proper nouns : dans la zone d'identité des parties uniquement.
  const scope = identityScope(withoutPlaceholders);
  const properNouns = new Set<string>();
  for (const line of scope.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*\d.)\s]+/, '');
    const words = cleaned.split(/\s+/);
    let atSentenceStart = true;

    for (const word of words) {
      const bare = word.replace(/[^\p{L}'’-]/gu, '');
      // « bailleurs'acquittent » : on ne garde que la partie après l'apostrophe.
      const tail = bare.includes("'") ? bare.slice(bare.lastIndexOf("'") + 1) : bare;
      const key = normalize(tail);
      const capitalized = tail.length >= 3 && /^\p{Lu}/u.test(tail);

      if (atSentenceStart) {
        // Premier mot de la phrase : presque toujours un mot courant.
        atSentenceStart = false;
        continue;
      }

      if (capitalized && !CONTRACT_STOPLIST.has(key) && !SENTENCE_STARTERS.has(key)) {
        properNouns.add(key);
      }

      if (/[.:!?»”]$/.test(word)) atSentenceStart = true;
    }
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
 * Splits a document into its blocks (separated by a blank line), as the
 * specification does: the blocks that were not asked to change must be
 * identical, byte for byte.
 */
export function blocks(markdown: string): string[] {
  return markdown
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Counts the blocks that changed between two documents.
 * A targeted edit changes a handful of blocks; a rewrite changes them all.
 */
export function countChangedBlocks(before: string, after: string): { added: number; removed: number; changed: number } {
  const beforeBlocks = blocks(before);
  const afterBlocks = blocks(after);

  const remaining = [...beforeBlocks];
  const kept: string[] = [];

  for (const block of afterBlocks) {
    const index = remaining.indexOf(block);
    if (index === -1) kept.push(block);
    else remaining.splice(index, 1);
  }

  return {
    added: kept.length,
    removed: remaining.length,
    changed: kept.length + remaining.length,
  };
}

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
