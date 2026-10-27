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
const envPath = resolve(root, 'cloudrun-env.yaml');

const START = '<!-- app-api:debut -->';
const END = '<!-- app-api:fin -->';

// Read PUBLIC_API_BASE from cloudrun-env.yaml if present
let publicApiBase = '';
try {
  const envContent = readFileSync(envPath, 'utf8');
  const match = envContent.match(/^PUBLIC_API_BASE:\s*"([^"]+)"/m);
  if (match) publicApiBase = match[1];
} catch {
  // File may not exist locally; that's fine
}

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

// Inject config before the app script
const configScript = publicApiBase
  ? `<script>window.__LEXCANVAS_CONFIG__={PUBLIC_API_BASE:${JSON.stringify(publicApiBase)}};</script>`
  : '';

const block = [
  START,
  configScript,
  '<script>',
  script,
  '</script>',
  END,
].join('\n');

html = html.slice(0, start) + block + html.slice(end + END.length);
writeFileSync(indexPath, html, 'utf8');
console.log("index.html : branchement de l'IA inject\u00E9" + (publicApiBase ? ` (PUBLIC_API_BASE=${publicApiBase})` : ''));
