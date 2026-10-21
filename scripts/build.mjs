/**
 * Build helper: compiles the TypeScript sources, then copies the assets that
 * `tsc` does not handle (the Word converter, kept as plain ESM JavaScript).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

const assets = [
  ['src/export/export-docx.mjs', 'dist/export/export-docx.mjs'],
  ['src/export/export-docx.d.mts', 'dist/export/export-docx.d.mts'],
];

for (const [from, to] of assets) {
  const source = resolve(root, from);
  if (!existsSync(source)) continue;
  mkdirSync(dirname(resolve(root, to)), { recursive: true });
  copyFileSync(source, resolve(root, to));
  console.log(`copié : ${from} -> ${to}`);
}

if (!existsSync(dist)) {
  console.error('dist/ est absent : lancez « npm run build » avant.');
  process.exit(1);
}

console.log('Build terminé.');
