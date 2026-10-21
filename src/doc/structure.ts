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
