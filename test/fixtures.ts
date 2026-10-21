import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REFERENCE_DIR = resolve(process.cwd(), 'reference');

export function readReference(relativePath: string): string {
  return readFileSync(resolve(REFERENCE_DIR, relativePath), 'utf8');
}

export const SAMPLE_BAIL = readReference('sample-bail.md');
export const SAMPLE_BAIL_TEMPLATE = readReference('template.bail-habitation.example.json');
