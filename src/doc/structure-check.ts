/**
 * Contrôle structurel du Markdown (P3).
 *
 * Le validateur général vérifie le sous-ensemble autorisé ; ce module vérifie
 * les constructions produites par les outils (tableaux GFM, listes, articles)
 * pour qu'un tableau mal formé ne redevienne pas un paragraphe illisible.
 */
import type { Issue, IssueSeverity } from './validate.js';
import { articles } from './structure.js';

function issue(code: string, severity: IssueSeverity, message: string): Issue {
  return { code, severity, message };
}

function splitRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '|' && value[index - 1] !== '\\') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/** Problèmes bloquants ou avertisseurs de structure. */
export function structureIssues(markdown: string): Issue[] {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const issues: Issue[] = [];

  for (let index = 0; index < lines.length;) {
    if (!/^\s*\|/.test(lines[index]!)) {
      index += 1;
      continue;
    }

    const tableLines: string[] = [];
    while (index < lines.length && /^\s*\|/.test(lines[index]!)) {
      tableLines.push(lines[index]!);
      index += 1;
    }

    if (tableLines.length < 2 || !isSeparator(tableLines[1]!)) {
      issues.push(issue(
        'malformed_table',
        'error',
        'Tableau Markdown incomplet : il manque la ligne de séparation « | --- | ».',
      ));
      continue;
    }

    const width = splitRow(tableLines[0]!).length;
    const mismatched = tableLines.slice(2).some((line) => splitRow(line).length !== width);
    if (mismatched) {
      issues.push(issue(
        'table_column_mismatch',
        'error',
        'Les lignes du tableau n’ont pas toutes le même nombre de colonnes.',
      ));
    }
  }

  const numbered = articles(text)
    .map((article) => article.number)
    .filter((number): number is number => number !== null);
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const number of numbered) {
    if (seen.has(number)) duplicates.add(number);
    seen.add(number);
  }
  if (duplicates.size > 0) {
    issues.push(issue(
      'duplicate_article_number',
      'error',
      `Numéro(s) d’article utilisé(s) plusieurs fois : ${[...duplicates].sort((a, b) => a - b).join(', ')}.`,
    ));
  }

  return issues;
}

export function blockingStructureIssues(markdown: string): Issue[] {
  return structureIssues(markdown).filter((item) => item.severity === 'error');
}
