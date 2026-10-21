/**
 * Sources juridiques citées par les modèles.
 *
 * La table vient du référentiel validé et est la **source unique**
 * (`data/legal-sources.json`) : elle alimente l'événement SSE `sources` et le
 * garde-fou de citations (`src/doc/references.ts`). Ce module ne fait que la
 * lire et la relier aux notes d'un modèle : il n'écrit aucune source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceItem } from './agent/events.js';
import type { ContractTemplate } from './templates.js';

export type SourceStatus = 'integrated' | 'partial' | 'to_verify' | 'not_found';

export interface LegalSource {
  code: string;
  aliases: string[];
  title: string;
  country: string;
  kind: 'law';
  date: string;
  status: SourceStatus;
  to_verify: boolean;
  applies_to: string[];
}

const SOURCES_PATH = resolve(process.cwd(), 'data', 'legal-sources.json');

let cache: LegalSource[] | null = null;

/** Table des sources, lue une fois. */
export function loadLegalSources(path: string = SOURCES_PATH): LegalSource[] {
  if (cache && path === SOURCES_PATH) return cache;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sources?: LegalSource[] };
  const sources = parsed.sources ?? [];
  if (path === SOURCES_PATH) cache = sources;
  return sources;
}

/** Une source est-elle applicable à un autre pays que la Côte d'Ivoire ? */
export function isForeignSource(source: LegalSource): boolean {
  return !/Côte d'Ivoire/i.test(source.country);
}

/**
 * Sources effectivement mobilisées par un modèle : celles que ses notes
 * juridiques citent.
 */
export function sourcesForTemplate(template: ContractTemplate | null): SourceItem[] {
  if (!template) return [];
  const sources = loadLegalSources();
  const notes = template.legal_notes.join('\n');

  return sources
    .filter((source) => {
      if (notes.includes(`[${source.code}`)) return true;
      return source.aliases.some((alias) => notes.includes(`[${alias}`));
    })
    .map((source) => ({
      id: source.code.toLowerCase(),
      title: source.title,
      ref: source.code,
      kind: source.kind,
      url: null,
    }));
}

/**
 * Sources citées dont le texte n'a pas été vérifié : le modèle doit les
 * mentionner sans citer un numéro d'article.
 */
export function unverifiedSourcesForTemplate(template: ContractTemplate | null): LegalSource[] {
  if (!template) return [];
  const notes = template.legal_notes.join('\n');
  return loadLegalSources().filter((source) => {
    const cited = notes.includes(`[${source.code}`)
      || source.aliases.some((alias) => notes.includes(`[${alias}`));
    return cited && source.to_verify;
  });
}
