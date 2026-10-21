import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';

/** Extrait le texte des paragraphes d'un .docx (les titres sont repérés par leur style). */
export async function extractDocx(path: string): Promise<Array<{ style: string; text: string }>> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const file = zip.file('word/document.xml');
  if (!file) return [];
  const xml = await file.async('string');

  const out: Array<{ style: string; text: string }> = [];
  const paragraphs = xml.split(/<w:p[ >]/).slice(1);

  for (const paragraph of paragraphs) {
    const styleMatch = /<w:pStyle w:val="([^"]+)"/.exec(paragraph);
    const style = styleMatch ? styleMatch[1]! : 'Normal';
    const texts = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((match) => match[1]!)
      .join('');
    const text = texts
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
    if (text) out.push({ style, text });
  }

  return out;
}

/** Trouve un fichier par fragment de nom (les noms contiennent des accents). */
export function findDocx(fragment: string): string {
  const match = readdirSync('reference').find((name) => name.endsWith('.docx') && name.includes(fragment));
  if (!match) throw new Error(`introuvable : ${fragment}`);
  return resolve('reference', match);
}

const targets = process.argv.slice(2);
if (targets.length > 0) {
  for (const target of targets) {
    const path = findDocx(target);
    console.log(`\n########## ${path.split(/[\\/]/).pop()} ##########`);
    const paragraphs = await extractDocx(path);
    for (const paragraph of paragraphs) {
      const lower = paragraph.style.toLowerCase();
      const marker = lower.includes('heading') || lower.includes('titre') ? '##' : lower === 'normal' ? '  ' : `[${paragraph.style}]`;
      console.log(`${marker} ${paragraph.text.slice(0, 150)}`);
    }
  }
} else {
  console.log(readdirSync('reference').filter((f) => f.endsWith('.docx')).join('\n'));
}
