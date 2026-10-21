import { readFileSync } from 'node:fs';

const raw = readFileSync('reference/TOUTES LES INFOS LEGALES.txt', 'latin1');
const text = raw;

console.log('=== longueur :', text.length, 'caractères ===\n');
console.log('=== STRUCTURE (lignes en majuscules ou SECTION) ===');
for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (/^(SECTION|Tableau \d+|PARTIE|CHAPITRE|ANNEXE|---)/i.test(trimmed)
    || /^[A-ZÀ-Ý][A-ZÀ-Ý0-9 ,.'’()\-–—:;]{12,}$/.test(trimmed)
    || /^\d+\.\d+\s+[A-ZÀ-Ý]/.test(trimmed)) {
    console.log(trimmed.slice(0, 150));
  }
}
