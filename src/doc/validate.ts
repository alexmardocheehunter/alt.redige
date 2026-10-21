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
import type { ContractTemplate } from '../templates.js';

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

  // Validators: reserved for V1. No legal rule is implemented without a validated content.
  if (template?.validators?.length) {
    for (const validator of template.validators) {
      issues.push(issue(
        `validator:${validator.id}`,
        validator.severity,
        validator.description,
      ));
    }
  }

  return { placeholders, issues };
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
