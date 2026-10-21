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

const markdown = extractPartialString(args, 'markdown');
console.log('extrait === CONTRACT ?', markdown === CONTRACT);
console.log('longueur extrait', markdown?.length, 'longueur contrat', CONTRACT.length);

if (markdown !== CONTRACT) {
  for (let i = 0; i < Math.max(markdown!.length, CONTRACT.length); i++) {
    if (markdown![i] !== CONTRACT[i]) {
      console.log(`premier ecart a l'index ${i} :`);
      console.log('  extrait :', JSON.stringify(markdown!.slice(Math.max(0, i - 40), i + 40)));
      console.log('  attendu:', JSON.stringify(CONTRACT.slice(Math.max(0, i - 40), i + 40)));
      break;
    }
  }
}
