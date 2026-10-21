import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractDocx } from './tmp-docx.js';

const files = readdirSync('reference').filter((name) => name.endsWith('.docx') && !name.includes('Copie'));

for (const file of files) {
  const path = resolve('reference', file);
  const paragraphs = await extractDocx(path);
  const articles = paragraphs
    .map((p) => p.text.trim())
    .filter((text) => /^ARTICLE\s+\d+/i.test(text) || /^Article\s+\d+/i.test(text));

  const titles = new Set<string>();
  for (const text of articles) {
    const match = /^(?:ARTICLE|Article)\s+(\d+)\s*[:\-–]?\s*(.+)$/i.exec(text);
    if (match) titles.add(`${match[1]} — ${match[2]!.slice(0, 70)}`);
  }

  console.log(`\n### ${file}`);
  console.log([...titles].join(' | ') || '(aucun article détecté)');
}
