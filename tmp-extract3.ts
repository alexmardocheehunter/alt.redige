import { extractPartialString, readPartialString } from './src/agent/json-partial.js';

const CONTRACT = `# Contrat de bail à usage d'habitation

Entre les soussignés :

**Monsieur Koné**, demeurant à Abidjan, ci-après désigné « le **Bailleur** »,
`;

const args = JSON.stringify({
  title: "Contrat de bail à usage d'habitation",
  contract_type: 'bail-habitation',
  markdown: CONTRACT,
});

console.log('args complet :', args.slice(0, 120), '...');
console.log('la chaine contient-elle "markdown" avant la cle ?', args.indexOf('markdown'), args.lastIndexOf('markdown'));

// Extraction sur le partial complet
const m = extractPartialString(args, 'markdown');
console.log('extrait === CONTRACT ?', m === CONTRACT, 'longueur', m?.length);
const t = readPartialString(args, 'title');
const c = readPartialString(args, 'contract_type');
console.log('title :', JSON.stringify(t), 'contract_type :', JSON.stringify(c));
