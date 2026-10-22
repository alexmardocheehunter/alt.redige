/**
 * Structure d'un document de contrat : articles, blocs, comparaison.
 *
 * Ces primitives servent à deux garde-fous côté serveur :
 *  - refuser une modification qui fait disparaître un article (P0-2) ;
 *  - mesurer l'ampleur réelle d'une modification (P0-2, P1-3).
 *
 * Aucune dépendance externe : le document est du Markdown restreint.
 */

/** Minuscules, sans accents — pour comparer deux intitulés. */
export function normalizeKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[«»"'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Intitulés des articles de niveau 2 (`## Article N – Intitulé`).
 * Renvoie les intitulés bruts, dans l'ordre du document.
 */
export function articleTitles(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) out.push(match[1]!.trim());
  }
  return out;
}

/**
 * Clés de comparaison des articles : le numéro quand il y en a un
 * (« Article 5 – Signatures » → « 5 »), sinon l'intitulé normalisé.
 *
 * Le numéro est prioritaire : un article renuméroté reste le même article,
 * tandis qu'un intitulé qui change légèrement ne le fait pas disparaître.
 */
export function articleKeys(markdown: string): string[] {
  const out: string[] = [];
  for (const title of articleTitles(markdown)) {
    const number = /article\s+(\d+)/i.exec(title);
    out.push(number ? `n${number[1]}` : `t:${normalizeKey(title)}`);
  }
  return out;
}

/** Blocs du document, séparés par une ligne vide. */
export function blocks(markdown: string): string[] {
  return markdown
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Compare deux documents et retourne ce qui a changé.
 *
 * `added` : blocs présents après et absents avant.
 * `removed` : blocs présents avant et absents après.
 * `changed` : la somme — le nombre de blocs touchés par la modification.
 */
export function countChangedBlocks(before: string, after: string): {
  added: number;
  removed: number;
  changed: number;
} {
  const remaining = [...blocks(before)];
  const kept: string[] = [];

  for (const block of blocks(after)) {
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
 * Articles présents avant la modification et disparus après.
 *
 * C'est le symptôme observé en conditions réelles : une modification « ciblée »
 * qui réécrit le document et emporte le bloc de signatures.
 */
export function lostArticles(before: string, after: string): string[] {
  const beforeKeys = articleKeys(before);
  const beforeTitles = articleTitles(before);
  const afterKeys = new Set(articleKeys(after));

  const lost: string[] = [];
  beforeKeys.forEach((key, index) => {
    if (!afterKeys.has(key)) lost.push(beforeTitles[index] ?? key);
  });
  return lost;
}

/** Un article : son numéro (si l'en-tête en porte un) et son intitulé. */
export interface ArticleInfo {
  number: number | null;
  title: string;
  /** Intitulé sans le préfixe « Article N », sans le tiret. */
  label: string;
}

const ARTICLE_HEADING = /^##\s+(?:Article\s+(\d+)\s*[–—-]\s*)?(.+)$/;

/** Liste les articles d'un document, dans l'ordre. */
export function articles(markdown: string): ArticleInfo[] {
  const out: ArticleInfo[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const title = match[1]!.trim();
    const number = /^Article\s+(\d+)/i.exec(title);
    out.push({
      number: number ? Number(number[1]) : null,
      title,
      label: title.replace(/^Article\s+\d+\s*[–—-]\s*/i, '').trim(),
    });
  }
  return out;
}

export interface RenumberResult {
  markdown: string;
  /** Ancienne numérotation → nouvelle numérotation (intitulé → numéro). */
  mapping: Map<string, number>;
  changed: boolean;
}

/**
 * Renumérote les articles et réécrit les renvois internes.
 *
 * Le serveur est **l'autorité** sur la numérotation : le modèle peut écrire
 * n'importe quel numéro, il est corrigé ici. Les renvois du texte
 * (« conformément à l'article 12 ») suivent le déplacement de l'article visé.
 *
 * La correspondance se fait par intitulé : un article qui a disparu ne
 * correspond plus à rien, et ses renvois sont signalés comme cassés.
 */
export function renumberArticles(before: string, after: string): RenumberResult {
  const beforeArticles = articles(before);
  const afterArticles = articles(after);

  // Correspondance par intitulé normalisé (le numéro change, l'intitulé reste).
  const byLabel = new Map<string, number>();
  beforeArticles.forEach((article, index) => {
    if (!byLabel.has(normalizeKey(article.label))) byLabel.set(normalizeKey(article.label), index + 1);
  });

  const mapping = new Map<string, number>();
  const lines = after.split(/\r?\n/);
  let articleIndex = 0;
  let changed = false;

  // Ancienne numérotation → nouvelle, établie par intitulé.
  const oldToNew = new Map<number, number>();
  beforeArticles.forEach((article) => {
    if (article.number === null) return;
    const target = mapping.get(normalizeKey(article.label));
    if (target !== undefined) oldToNew.set(article.number, target);
  });

  const rewriteReference = (text: string): string => text.replace(
    /\b(articles?)\s+(\d+)\b/gi,
    (whole, word: string, number: string) => {
      const target = oldToNew.get(Number(number));
      return target === undefined ? whole : `${word} ${target}`;
    },
  );

  const newLines = lines.map((line) => {
    const match = ARTICLE_HEADING.exec(line.trim());
    // Les titres d'articles sont renumérotés, pas réécrits : ils portent la
    // nouvelle numérotation, les renvois du corps suivent le déplacement.
    if (!match) return rewriteReference(line);

    articleIndex += 1;
    const cleanLabel = (match[2] ?? '').trim();
    const oldPosition = byLabel.get(normalizeKey(cleanLabel));
    if (oldPosition !== undefined) mapping.set(normalizeKey(cleanLabel), articleIndex);

    const wanted = `## Article ${articleIndex} – ${cleanLabel}`;
    if (line.trim() !== wanted) changed = true;
    return wanted;
  });

  let markdown = newLines.join('\n');

  // La correspondance par intitulé est connue après le parcours des titres :
  // on applique alors la réécriture des renvois.
  if (mapping.size > 0) {
    beforeArticles.forEach((article) => {
      if (article.number === null) return;
      const target = mapping.get(normalizeKey(article.label));
      if (target !== undefined) oldToNew.set(article.number, target);
    });

    if (oldToNew.size > 0) {
      markdown = markdown.split(/\r?\n/).map((line) => {
        if (ARTICLE_HEADING.test(line.trim())) return line;
        return rewriteReference(line);
      }).join('\n');
    }
  }

  return { markdown, mapping, changed: changed || markdown !== after };
}

/**
 * Renvois internes pointant vers un article inexistant.
 * « conformément à l'article 12 » alors qu'il n'y a que 8 articles.
 */
export function brokenReferences(markdown: string): number[] {
  const count = articles(markdown).length;
  if (count === 0) return [];
  const broken = new Set<number>();
  for (const match of markdown.matchAll(/\barticles?\s+(\d+)\b/gi)) {
    const number = Number(match[1]);
    if (number < 1 || number > count) broken.add(number);
  }
  return [...broken].sort((a, b) => a - b);
}
