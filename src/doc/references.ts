/**
 * Références normatives : ce que le document a le droit de citer.
 *
 * Principe : une mention normative (OHADA, un code, une loi, un article) n'est
 * admise que si elle figure dans les `legal_notes` du modèle — c'est-à-dire
 * dans le référentiel validé fourni par l'humain. Aucune source n'est écrite
 * ici : le module ne fait que comparer.
 *
 * Une référence interne au contrat (« comme prévu à l'Article 3 ») n'est pas
 * une mention normative : elle n'est jamais signalée.
 */
import type { ContractTemplate } from '../templates.js';

/** Minuscules, sans accents, ponctuation réduite à des espaces. */
export function normalizeReference(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/n[°ºo]/g, 'n')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Noms de codes et d'organismes susceptibles d'être cités. */
const SOURCE_KEYWORDS = [
  'ohada',
  'audcg',
  'syscohada',
  'cgi',
  'cnps',
  'cps',
  'code du travail',
  'code civil',
  'code des procedures civiles',
  'code penal',
  'code de prevoyance sociale',
  'code general des impots',
  'code de commerce',
  'acte uniforme',
  'convention collective',
  'plan comptable',
  'cahier des charges',
];

/** Formes textuelles qui annoncent une source normative. */
const SOURCE_CONTEXT = /\b(loi|ordonnance|decret|arrete|acte uniforme|code|convention collective|cahier des charges|reglement)\b/i;

/**
 * Numéros d'articles autorisés, lus dans les notes juridiques.
 * `[S02, art. 169 bis]` → « 169 bis » ; `article 530` → « 530 ».
 */
export function allowedArticleNumbers(template: ContractTemplate): Set<string> {
  const out = new Set<string>();
  const text = template.legal_notes.join('\n');
  for (const match of text.matchAll(/\b(?:art|article)\.?\s*(\d+[\s\w-]*)/gi)) {
    const number = match[1]!.trim().replace(/\s+/g, ' ');
    if (number) out.add(number);
  }
  return out;
}

/** Mots-clés de sources présents dans les notes juridiques du modèle. */
export function allowedSourceKeywords(template: ContractTemplate): Set<string> {
  const notes = normalizeReference(template.legal_notes.join(' '));
  const out = new Set<string>();
  for (const keyword of SOURCE_KEYWORDS) {
    if (notes.includes(normalizeReference(keyword))) out.add(keyword);
  }
  return out;
}

/**
 * Mentions normatives du document.
 *
 * @returns les mentions **non autorisées** par le modèle (vide si tout va bien).
 */
export function checkReferences(
  markdown: string,
  template: ContractTemplate | null,
): string[] {
  if (!template) return [];

  const allowedKeywords = allowedSourceKeywords(template);
  const allowedNumbers = allowedArticleNumbers(template);
  const notes = normalizeReference(template.legal_notes.join(' '));

  const unsupported: string[] = [];
  const report = (mention: string) => {
    if (!unsupported.includes(mention)) unsupported.push(mention);
  };

  // 1. Codes, organismes, actes uniformes, conventions collectives.
  const lower = markdown.toLowerCase();
  for (const keyword of SOURCE_KEYWORDS) {
    if (!lower.includes(keyword)) continue;
    if (!allowedKeywords.has(keyword)) report(keyword);
  }

  // 2. Lois, ordonnances, décrets, arrêtés : la référence complète doit figurer
  //    dans les notes (numéro compris).
  for (const match of markdown.matchAll(
    /\b(loi|ordonnance|d[ée]cret|arr[êe]t[ée])\s+n\s*([\d][\d\w./-]*)/gi,
  )) {
    const mention = normalizeReference(`${match[1]} n ${match[2]}`);
    if (!notes.includes(mention)) report(`${match[1]} n° ${match[2]}`);
  }

  // 3. Articles : seuls ceux dont le numéro figure dans les notes sont
  //    acceptés. Les renvois internes (« l'Article 3 ») ne sont jamais
  //    signalés, leur numéro n'est pas dans les notes.
  for (const match of markdown.matchAll(/\barticles?\s+(\d+[\s\w-]*)/gi)) {
    const number = match[1]!.trim().replace(/\s+/g, ' ');
    if (!allowedNumbers.has(number)) continue; // renvoi interne : sans effet
    if (!notes.includes(normalizeReference(`art ${number}`))) {
      report(`article ${number}`);
    }
  }

  return unsupported;
}
