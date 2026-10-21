/**
 * Injecte `public/app-api.js` dans `public/index.html`.
 *
 * Le frontend doit rester un fichier unique (`public/index.html`) : le code de
 * branchement de l'IA est donc intégré entre deux marqueurs, et le nonce de
 * la Content-Security-Policy l'autorise comme le script inline du prototype.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(root, 'public', 'index.html');
const scriptPath = resolve(root, 'public', 'app-api.js');

const START = '<!-- app-api:debut -->';
const END = '<!-- app-api:fin -->';

const script = readFileSync(scriptPath, 'utf8');
if (script.includes('</script>')) {
  console.error('app-api.js contient une balise de fermeture de script : injection impossible.');
  process.exit(1);
}

let html = readFileSync(indexPath, 'utf8');
const start = html.indexOf(START);
const end = html.indexOf(END);

if (start === -1 || end === -1 || end < start) {
  console.error('Marqueurs app-api absents de public/index.html.');
  process.exit(1);
}

const block = [
  START,
  '<script>',
  script,
  '</script>',
  END,
].join('\n');

html = html.slice(0, start) + block + html.slice(end + END.length);
writeFileSync(indexPath, html, 'utf8');
console.log('index.html : branchement de l’IA injecté.');
