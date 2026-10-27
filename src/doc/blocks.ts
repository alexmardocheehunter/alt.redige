/**
 * Blocs Markdown structurés utilisés par les outils de l'assistant (P3).
 *
 * Le contrat reste du Markdown restreint : ces fonctions produisent des
 * tableaux GFM, des listes et des blocs de signatures déterministes, puis les
 * insèrent à un endroit précis du document.
 */
import { articles, articleKeys, normalizeKey } from './structure.js';

export interface ArticleRange {
  title: string;
  label: string;
  number: number | null;
  /** Offset du début de la ligne « ## Article … ». */
  start: number;
  /** Offset juste après le titre (avant le saut de ligne). */
  headingEnd: number;
  /** Offset du début du corps. */
  bodyStart: number;
  /** Offset du début de l'article suivant, ou fin du document. */
  end: number;
}

function normalized(markdown: string): string {
  return String(markdown ?? '').replace(/\r\n?/g, '\n');
}

/** Positions des articles de niveau 2 dans le document. */
export function articleRanges(markdown: string): ArticleRange[] {
  const text = normalized(markdown);
  const lines = text.split('\n');
  const ranges: ArticleRange[] = [];
  let offset = 0;

  for (const line of lines) {
    const match = /^##\s+(.+)$/.exec(line.trim());
    if (match) {
      const title = match[1]!.trim();
      const numberMatch = /^Article\s+(\d+)/i.exec(title);
      ranges.push({
        title,
        label: title.replace(/^Article\s+\d+\s*[–—-]\s*/i, '').trim(),
        number: numberMatch ? Number(numberMatch[1]) : null,
        start: offset,
        headingEnd: offset + line.length,
        bodyStart: offset + line.length + 1,
        end: text.length,
      });
    }
    offset += line.length + 1;
  }

  for (let index = 0; index < ranges.length - 1; index += 1) {
    ranges[index]!.end = ranges[index + 1]!.start;
  }
  return ranges;
}

/** Retrouve un article par numéro, intitulé ou titre complet. */
export function findArticleRange(markdown: string, wanted: string): ArticleRange | null {
  const value = String(wanted ?? '').trim();
  if (!value) return null;
  const ranges = articleRanges(markdown);
  const numberMatch = /^(?:article\s+)?(\d+)$/i.exec(value);
  if (numberMatch) {
    return ranges.find((range) => range.number === Number(numberMatch[1])) ?? null;
  }

  const key = normalizeKey(value);
  const exact = ranges.find((range) => normalizeKey(range.title) === key || normalizeKey(range.label) === key);
  if (exact) return exact;
  return ranges.find((range) => normalizeKey(range.title).includes(key) || key.includes(normalizeKey(range.label))) ?? null;
}

/** Remplace le corps d'un article, en conservant son titre. */
export function replaceArticleBody(markdown: string, article: string, body: string): string {
  const text = normalized(markdown);
  const range = findArticleRange(text, article);
  if (!range) throw new Error(`Article introuvable : « ${article} ».`);
  const content = normalized(body).trim();
  if (!content) throw new Error('Le corps de l’article est vide.');

  const prefix = text.slice(0, range.bodyStart);
  const suffix = text.slice(range.end).replace(/^\n+/, '');
  return prefix + '\n' + content + (suffix ? '\n\n' + suffix : '\n');
}

/** Insère un bloc à la fin d'un article (ou à la fin du document). */
export function insertBlock(markdown: string, block: string, article?: string): string {
  const text = normalized(markdown);
  const content = normalized(block).trim();
  if (!content) throw new Error('Le bloc à insérer est vide.');

  if (article) {
    const range = findArticleRange(text, article);
    if (!range) throw new Error(`Article introuvable : « ${article} ».`);
    const before = text.slice(0, range.end).replace(/\s+$/, '');
    const after = text.slice(range.end).replace(/^\n+/, '');
    return before + '\n\n' + content + (after ? '\n\n' + after : '\n');
  }

  const before = text.replace(/\s+$/, '');
  return before + '\n\n' + content + '\n';
}

/** Tableau GFM rectangulaire ; la première ligne est l'en-tête. */
export function tableToMarkdown(rows: string[][]): string {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Le tableau est vide.');
  const width = rows[0]!.length;
  if (width === 0) throw new Error('Le tableau n’a aucune colonne.');
  const normalizedRows = rows.map((row) => {
    if (!Array.isArray(row)) throw new Error('Chaque ligne du tableau doit être une liste de cellules.');
    const copy = row.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });

  const escape = (value: string): string => String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();

  const lines = normalizedRows.map((row) => `| ${row.map(escape).join(' | ')} |`);
  lines.splice(1, 0, `| ${normalizedRows[0]!.map(() => '---').join(' | ')} |`);
  return lines.join('\n');
}

/** Liste à puces ou numérotée. */
export function listToMarkdown(items: string[], ordered = false, start = 1): string {
  const clean = items.map((item) => String(item ?? '').trim()).filter(Boolean);
  if (clean.length === 0) throw new Error('La liste est vide.');
  return clean.map((item, index) => {
    const prefix = ordered ? `${start + index}. ` : '- ';
    return prefix + item.replace(/\r?\n/g, ' ');
  }).join('\n');
}

export interface SignatureParty {
  name?: string;
  first_name?: string;
  role?: string;
  date?: string;
}

function signatureTable(parties: SignatureParty[]): string {
  const headers = parties.map((party, index) => {
    const name = [party.name, party.first_name].filter(Boolean).join(' ').trim();
    return name || `Partie ${index + 1}`;
  });

  const row = (label: string, value: (party: SignatureParty) => string): string[] => parties.map((party) => {
    const detail = value(party);
    return detail ? `${label} : ${detail}` : `${label} :`;
  });

  const rows: string[][] = [
    headers,
    parties.map(() => 'Lu et approuvé'),
    row('Signature', () => ''),
    row('Nom', (party) => party.name ?? ''),
    row('Prénom', (party) => party.first_name ?? ''),
    row('Fonction', (party) => party.role ?? ''),
    row('Date', (party) => party.date ?? ''),
  ];
  return tableToMarkdown(rows);
}

/** L'article de signatures existant, s'il y en a un. */
export function signatureArticle(markdown: string): ArticleRange | null {
  return articleRanges(markdown).find((range) => normalizeKey(range.label).includes('signature')) ?? null;
}

export function hasSignatureTable(markdown: string): boolean {
  const range = signatureArticle(markdown);
  if (!range) return false;
  const body = normalized(markdown).slice(range.bodyStart, range.end);
  return /^\s*\|.+\|\s*$/m.test(body) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/m.test(body);
}

/**
 * Insère — ou met à jour — un bloc de signatures déterministe.
 *
 * Si un article « Signatures » existe, son tableau est remplacé et le texte
 * d'introduction (par exemple « Fait à Abidjan, le … ») est conservé. Sinon,
 * un article est ajouté en fin de document ; le serveur le renumérote ensuite.
 */
export function insertSignatureBlock(
  markdown: string,
  parties: SignatureParty[],
  intro?: string,
): string {
  if (!Array.isArray(parties) || parties.length === 0) {
    throw new Error('Indique au moins une partie pour le bloc de signatures.');
  }
  const table = signatureTable(parties);
  const text = normalized(markdown);
  const range = signatureArticle(text);

  if (range) {
    const body = text.slice(range.bodyStart, range.end);
    const kept = body
      .split('\n')
      .filter((line) => !/^\s*\|/.test(line))
      .join('\n')
      .trim();
    const introduction = intro?.trim() || kept;
    const newBody = [introduction, table].filter(Boolean).join('\n\n');
    return replaceArticleBody(text, range.title, newBody);
  }

  const number = articles(text).length + 1;
  const heading = `## Article ${number} – Signatures`;
  const body = [intro?.trim(), table].filter(Boolean).join('\n\n');
  const before = text.replace(/\s+$/, '');
  return `${before}\n\n${heading}\n\n${body}\n`;
}

const ENGAGING_LABEL = /priorit[ée]\s+d.embauche|exclusivit|non.concurrence|p[ée]nalit|responsabilit[ée]|caution|garantie|d[ée]dit|confidentialit[ée]/i;

/** Articles nouvellement ajoutés qui créent une obligation importante. */
export function newEngagingArticles(before: string, after: string): string[] {
  const beforeKeys = new Set(articleKeys(before));
  return articles(after)
    .filter((article) => {
      const key = article.number === null
        ? `t:${normalizeKey(article.title)}`
        : `n${article.number}`;
      return !beforeKeys.has(key) && ENGAGING_LABEL.test(article.label);
    })
    .map((article) => article.title);
}

/** L'utilisateur a-t-il explicitement demandé ou confirmé la clause ? */
export function userConsentedToClause(userText: string): boolean {
  const explicit = /\b(?:ajoute|ajouter|ins[èe]re|ins[ée]rer|cr[ée]e|cr[ée]er)\b/i.test(userText)
    && /\b(?:clause|article|p[ée]nalit[ée]|exclusivit[ée]|non.?concurrence|confidentialit[ée]|embauche|caution|garantie|responsabilit[ée])\b/i.test(userText);
  const confirmation = /\b(?:oui|d.accord|confirme|confirm[ée]|accepte|accept[ée])\b/i.test(userText);
  return explicit || confirmation;
}
