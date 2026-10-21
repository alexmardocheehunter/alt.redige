/**
 * Validation of the contract Markdown subset.
 *
 * Pure function: `validate(markdown, template?) => { placeholders, issues }`.
 *
 * The rules below encode the subset defined in docs/API-CONTRACT.md §5.
 * Legal rules (`validators`) stay empty in V1: no legal rule is invented here.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import type { ContractTemplate, ValidatorCheck } from '../templates.js';
import { brokenReferences } from './structure.js';
import { missingRequiredFields } from './required-fields.js';
import { findEnglishWords } from './lexical.js';

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface Issue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

export interface ValidationResult {
  placeholders: number;
  issues: Issue[];
}

export const PLACEHOLDER_PATTERN = /\[À COMPLÉTER[^\]]*\]/g;
const OPEN_PLACEHOLDER_PATTERN = /\[À COMPLÉTER[^\]]*/g;
const HEADING_PATTERN = /^#{1,6}\s+(.*)$/;

/** Lowercase, without diacritics — used to compare article titles. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function issue(code: string, severity: IssueSeverity, message: string): Issue {
  return { code, severity, message };
}

interface HeadingInfo {
  depth: number;
  title: string;
}

interface ScanResult {
  headings: HeadingInfo[];
  forbidden: Array<{ code: string; message: string }>;
}

function scanMarkdown(markdown: string): ScanResult {
  const tree = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });

  const headings: HeadingInfo[] = [];
  const forbidden: Array<{ code: string; message: string }> = [];

  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;

    switch (node.type) {
      case 'heading':
        headings.push({ depth: node.depth, title: String(node.children?.[0]?.value ?? '') });
        if (node.depth >= 4) {
          forbidden.push({
            code: 'forbidden_construct',
            message: `Titre de niveau ${node.depth} non autorisé (niveau 3 maximum).`,
          });
        }
        break;
      case 'html':
        if (!/^\s*<!--\s*pagebreak\s*-->\s*$/i.test(String(node.value ?? ''))) {
          forbidden.push({
            code: 'forbidden_construct',
            message: 'HTML non autorisé (seul <!-- pagebreak --> est accepté).',
          });
        }
        break;
      case 'image':
        forbidden.push({ code: 'forbidden_construct', message: 'Image non autorisée.' });
        break;
      case 'link':
        forbidden.push({
          code: 'forbidden_construct',
          message: 'Lien non autorisé : écrivez l’adresse en texte simple.',
        });
        break;
      case 'code':
        forbidden.push({ code: 'forbidden_construct', message: 'Bloc de code non autorisé.' });
        break;
      case 'definition':
        forbidden.push({ code: 'forbidden_construct', message: 'Lien non autorisé : écrivez l’adresse en texte simple.' });
        break;
      case 'linkReference':
        forbidden.push({
          code: 'forbidden_construct',
          message: 'Lien non autorisé : écrivez l’adresse en texte simple.',
        });
        break;
      case 'imageReference':
        forbidden.push({ code: 'forbidden_construct', message: 'Image non autorisée.' });
        break;
      case 'footnoteDefinition':
        forbidden.push({ code: 'forbidden_construct', message: 'Note de bas de page non autorisée.' });
        break;
      default:
        break;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child);
  };

  for (const child of tree.children) visit(child);
  return { headings, forbidden };
}

/**
 * Validates a contract document.
 * @param markdown  the document to validate
 * @param template  optional template, used to check the required articles
 */
export function validate(markdown: string, template?: ContractTemplate | null): ValidationResult {
  const issues: Issue[] = [];
  const text = markdown ?? '';
  const { headings, forbidden } = scanMarkdown(text);

  const placeholders = (text.match(PLACEHOLDER_PATTERN) ?? []).length;

  // Titles: exactly one level-1 heading.
  const levelOne = headings.filter((heading) => heading.depth === 1);
  if (levelOne.length === 0) {
    issues.push(issue('missing_title', 'warning', 'Le document n’a pas de titre (# Titre).'));
  } else if (levelOne.length > 1) {
    issues.push(issue('multiple_titles', 'warning', `Le document contient ${levelOne.length} titres de niveau 1 (un seul attendu).`));
  }

  for (const item of forbidden) {
    issues.push(issue(item.code, 'warning', item.message));
  }

  // Required articles (only when a template is provided).
  if (template) {
    const articleHeadings = headings.filter((heading) => heading.depth === 2);
    for (const required of template.required_articles) {
      const needle = normalizeText(required);
      if (!needle) continue;
      const found = articleHeadings.some((heading) => normalizeText(heading.title).includes(needle));
      if (!found) {
        issues.push(issue('missing_article', 'warning', `Article « ${required} » absent.`));
      }
    }

    // Mandatory fields left empty: one issue per field (P1-5). The field is
    // considered empty when every placeholder associated with it in the
    // skeleton is still present in the document.
    for (const field of missingRequiredFields(template, text)) {
      issues.push(issue(
        'required_field',
        'warning',
        `Champ obligatoire « ${field.label} » non renseigné.`,
      ));
    }
  }

  // Unclosed placeholders.
  const openCount = (text.match(OPEN_PLACEHOLDER_PATTERN) ?? []).length;
  if (openCount > placeholders) {
    issues.push(issue(
      'placeholder_format',
      'info',
      `${openCount - placeholders} espace(s) réservé(s) sans crochet fermant.`,
    ));
  }

  // Anglicismes : un acte de droit est rédigé en français.
  const anglicisms = findEnglishWords(text);
  if (anglicisms.length > 0) {
    issues.push(issue(
      'anglicism',
      'warning',
      `Terme(s) en anglais dans le document : ${anglicisms.join(', ')}.`,
    ));
  }

  // Renvois internes pointant vers un article inexistant : le numéro écrit
  // par le modèle ne correspond à aucun article du document.
  const broken = brokenReferences(text);
  if (broken.length > 0) {
    issues.push(issue(
      'broken_reference',
      'warning',
      `Renvoi interne vers un article inexistant : ${broken.map((n) => `article ${n}`).join(', ')}.`,
    ));
  }

  // Validators: règles juridiques chiffrées, exécutées quand elles sont
  // mécaniquement vérifiables. Le contenu vient du référentiel validé.
  if (template?.validators?.length) {
    for (const validator of template.validators) {
      const problem = runValidator(validator, markdown);
      if (problem) {
        issues.push(issue(`validator:${validator.id}`, validator.severity, problem));
      }
    }
  }

  return { placeholders, issues };
}

/* ------------------------------------------------------------------ */
/* Validateurs                                                         */
/* ------------------------------------------------------------------ */

/** Paragraphes du document, avec leur texte. */
function paragraphs(markdown: string): string[] {
  return markdown.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
}

function inScope(paragraph: string, scope?: string[]): boolean {
  if (!scope || scope.length === 0) return true;
  const normalized = normalizeText(paragraph);
  return scope.some((word) => normalized.includes(normalizeText(word)));
}

/** Durées exprimées en mois. */
function durationsInMonths(paragraph: string): number[] {
  const out: number[] = [];
  const patterns: Array<[RegExp, number]> = [
    [/\b(\d+)\s*(?:mois)\b/gi, 1],
    [/\b(\d+)\s*(?:an|ans|année|années)\b/gi, 12],
    [/\b(\d+)\s*(?:semaine|semaines)\b/gi, 0.25],
    [/\b(\d+)\s*(?:jour|jours)\b/gi, 1 / 30],
  ];
  for (const [pattern, factor] of patterns) {
    for (const match of paragraph.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) out.push(value * factor);
    }
  }
  return out;
}

/** Montants en FCFA. */
function amountsInFcfa(paragraph: string): number[] {
  const out: number[] = [];
  for (const match of paragraph.matchAll(/(\d[\d\s  .]*)\s*(?:FCFA|XOF|francs?\s*CFA)/gi)) {
    const digits = match[1]!.replace(/[\s  .]/g, '');
    const value = Number(digits);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

function percentagesIn(paragraph: string): number[] {
  const out: number[] = [];
  for (const match of paragraph.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    const value = Number(match[1]!.replace(',', '.'));
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

function agesIn(paragraph: string): number[] {
  const out: number[] = [];
  for (const match of paragraph.matchAll(/\b(\d{1,2})\s*ans?\b/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value <= 120) out.push(value);
  }
  return out;
}

/**
 * Montant qui suit le mot-clé de la règle dans le paragraphe.
 *
 * Un paragraphe peut contenir plusieurs montants (un salaire de base et une
 * prime) : c'est celui qui suit le mot-clé qui concerne la règle.
 */
function amountAfterScope(paragraph: string, scope?: string[]): number | undefined {
  if (!scope || scope.length === 0) return undefined;
  const normalized = paragraph.toLowerCase();

  let start = Number.POSITIVE_INFINITY;
  for (const word of scope) {
    const index = normalized.indexOf(normalizeText(word).toLowerCase());
    if (index !== -1 && index < start) start = index;
  }
  if (!Number.isFinite(start)) return undefined;

  const amounts = amountsInFcfa(paragraph.slice(start));
  return amounts[0];
}

/**
 * Exécute une règle de validateur.
 * Renvoie `null` si la règle est respectée, ou si elle est inapplicable
 * (valeur absente du document : on ne peut pas conclure).
 */
export function runValidator(
  validator: { description: string; check?: ValidatorCheck },
  markdown: string,
): string | null {
  const check = validator.check;
  if (!check || check.type === 'info_only') return null;

  const blocks = paragraphs(markdown);
  const scoped = check.scope ? blocks.filter((block) => inScope(block, check.scope)) : blocks;

  switch (check.type) {
    case 'max_duration_months': {
      if (check.value === undefined) return null;
      const months = scoped.flatMap((block) => durationsInMonths(block));
      if (months.length === 0) return null;
      const worst = Math.max(...months);
      if (worst > check.value) {
        const found = months.find((month) => month === worst)!;
        return `${validator.description} Valeur trouvée : ${formatNumber(found)} mois (maximum ${check.value} mois).`;
      }
      return null;
    }

    case 'min_amount_fcfa': {
      if (check.value === undefined) return null;
      const amounts = check.scope
        ? scoped
          .map((block) => amountAfterScope(block, check.scope))
          .filter((amount): amount is number => amount !== undefined)
        : scoped.flatMap((block) => amountsInFcfa(block));
      if (amounts.length === 0) return null;
      const lowest = Math.min(...amounts);
      if (lowest < check.value) {
        return `${validator.description} Valeur trouvée : ${formatNumber(lowest)} FCFA (minimum ${formatNumber(check.value)} FCFA).`;
      }
      return null;
    }

    case 'max_amount_fcfa': {
      if (check.value === undefined) return null;
      const amounts = scoped.flatMap((block) => amountsInFcfa(block));
      if (amounts.length === 0) return null;
      const highest = Math.max(...amounts);
      if (highest > check.value) {
        return `${validator.description} Valeur trouvée : ${formatNumber(highest)} FCFA (maximum ${formatNumber(check.value)} FCFA).`;
      }
      return null;
    }

    case 'min_percentage': {
      if (check.value === undefined) return null;
      const percentages = scoped.flatMap((block) => percentagesIn(block));
      if (percentages.length === 0) return null;
      const lowest = Math.min(...percentages);
      if (lowest < check.value) {
        return `${validator.description} Valeur trouvée : ${formatNumber(lowest)} % (minimum ${check.value} %).`;
      }
      return null;
    }

    case 'min_age_years': {
      if (check.value === undefined) return null;
      const ages = scoped.flatMap((block) => agesIn(block));
      if (ages.length === 0) return null;
      const lowest = Math.min(...ages);
      if (lowest < check.value) {
        return `${validator.description} Valeur trouvée : ${lowest} ans (minimum ${check.value} ans).`;
      }
      return null;
    }

    case 'required_phrases': {
      const phrases = check.phrases ?? [];
      if (phrases.length === 0) return null;
      const normalized = normalizeText(markdown);
      const found = phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
      if (!found) {
        return `${validator.description} Mention attendue : « ${phrases[0]} ».`;
      }
      return null;
    }

    case 'forbidden_phrases': {
      const phrases = check.phrases ?? [];
      if (phrases.length === 0) return null;
      const normalized = normalizeText(markdown);
      const found = phrases.find((phrase) => normalized.includes(normalizeText(phrase)));
      if (found) {
        return `${validator.description} Mention interdite trouvée : « ${found} ».`;
      }
      return null;
    }

    default:
      return null;
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

/** Counts the placeholders without running the whole validation. */
export function countPlaceholders(markdown: string): number {
  return (markdown.match(PLACEHOLDER_PATTERN) ?? []).length;
}

/** True when the string holds at least one `# ` title. */
export function hasTitle(markdown: string): boolean {
  return /^#\s+/m.test(markdown);
}

/** Headings of level 2 (the articles), as raw strings. */
export function articleTitles(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = HEADING_PATTERN.exec(line);
    if (match && /^##\s+/.test(line)) out.push(match[1]!.trim());
  }
  return out;
}
