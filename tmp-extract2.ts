import { extractPartialString } from './src/agent/json-partial.js';

const CONTRACT = `# Contrat de bail à usage d'habitation

Entre les soussignés :

**Monsieur Koné**, demeurant à Abidjan, ci-après désigné « le **Bailleur** »,
`;

const args = JSON.stringify({
  title: "Contrat de bail à usage d'habitation",
  contract_type: 'bail-habitation',
  markdown: CONTRACT,
});

let partial = '';
let emitted = '';
const chunks: string[] = [];

for (let i = 0; i < args.length; i += 40) {
  partial += args.slice(i, i + 40);
  const markdown = extractPartialString(partial, 'markdown');
  if (markdown === undefined) { chunks.push(`chunk ${i}: undefined`); continue; }
  const starts = markdown.startsWith(emitted);
  const suffix = markdown.slice(emitted.length);
  chunks.push(`chunk ${i}: extrait ${markdown.length} car, commence par emis=${starts}, suffixe ${suffix.length}`);
  if (starts) emitted = markdown;
}

console.log(chunks.join('\n'));
console.log('\nemitted final :', emitted.length, '— CONTRACT :', CONTRACT.length);
