/**
 * Localisation des espaces réservés `[À COMPLÉTER : ...]` (P3).
 *
 * Le serveur ne rédige aucun droit : il se contente de retrouver les champs
 * déjà présents dans le Markdown et l'article auquel chacun appartient.
 */

export const PLACEHOLDER_PATTERN = /\[À COMPLÉTER[^\]]*\]/g;

export interface PlaceholderItem {
  raw: string;
  label: string;
  article: string | null;
  article_number: number | null;
}

export interface PlaceholderReport {
  count: number;
  items: PlaceholderItem[];
  by_article: Array<{ article: string; count: number }>;
}

function labelOf(raw: string): string {
  const inner = raw.replace(/^\[À COMPLÉTER\s*:?\s*/i, '').replace(/\]$/, '').trim();
  return inner || 'Champ à compléter';
}

/** Liste les espaces réservés et l'article qui les précède. */
export function listPlaceholders(markdown: string): PlaceholderReport {
  const items: PlaceholderItem[] = [];
  let article: string | null = null;
  let articleNumber: number | null = null;

  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading) {
      article = heading[1]!.trim();
      const number = /^Article\s+(\d+)/i.exec(article);
      articleNumber = number ? Number(number[1]) : null;
    }

    for (const match of line.matchAll(PLACEHOLDER_PATTERN)) {
      const raw = match[0];
      items.push({
        raw,
        label: labelOf(raw),
        article,
        article_number: articleNumber,
      });
    }
  }

  const byArticle = new Map<string, number>();
  for (const item of items) {
    const key = item.article ?? 'En-tête';
    byArticle.set(key, (byArticle.get(key) ?? 0) + 1);
  }

  return {
    count: items.length,
    items,
    by_article: [...byArticle.entries()].map(([article, count]) => ({ article, count })),
  };
}
