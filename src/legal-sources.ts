/**
 * Sources juridiques citées par les modèles.
 *
 * La table vient du référentiel validé (`data/legal-sources.json`, repris de
 * `reference/TOUTES LES INFOS LEGALES.txt`). Ce module ne fait que la lire et
 * la relier aux notes d'un modèle : il n'écrit aucune source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SourceItem } from './agent/events.js';
import type { ContractTemplate } from './templates.js';

export interface LegalSource {
  code: string;
  title: string;
  date: string;
  kind: 'law';
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

/**
 * Sources effectivement mobilisées par un modèle : celles que ses notes
 * juridiques citent.
 */
export function sourcesForTemplate(template: ContractTemplate | null): SourceItem[] {
  if (!template) return [];
  const sources = loadLegalSources();
  const notes = template.legal_notes.join('\n');

  return sources
    .filter((source) => notes.includes(`[${source.code}`) || notes.includes(`${source.code},`))
    .map((source) => ({
      id: source.code.toLowerCase(),
      title: source.title,
      ref: source.code,
      kind: source.kind,
      url: null,
    }));
}
