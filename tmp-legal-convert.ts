import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync('reference/TOUTES LES INFOS LEGALES.txt', 'latin1');
writeFileSync('tmp-legal-utf8.txt', raw, 'utf8');
console.log('converti :', raw.length, 'caracteres');
console.log('sections trouvees :', (raw.match(/^SECTION \d+ /gm) ?? []).length);
console.log('fiches 3.x :', [...raw.matchAll(/^3\.\d+ .+$/gm)].map((m) => m[0]).join(' | '));
