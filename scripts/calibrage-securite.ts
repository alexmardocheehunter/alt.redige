/**
 * Calibrage du gardien de sécurité sur un échantillon réel.
 *
 * Le gardien (`nvidia/nemotron-3.5-content-safety:free`) classe les messages
 * de l'utilisateur. La question à laquelle ce script répond est précise :
 * **sur un échantillon relu par un humain, combien de demandes légitimes sont
 * bloquées à tort, et combien de demandes dangereuses sont laissées passer ?**
 *
 * Le script ne modifie rien : il mesure. Il compare deux réglages :
 *  - `advisory` (réglage par défaut) : on bloque hors du domaine, on journalise
 *    dans le domaine ;
 *  - `block` : on bloque partout, y compris dans le domaine.
 *
 * Usage :
 *   NODE_OPTIONS=--tls-max-v1.2 npx tsx scripts/calibrage-securite.ts
 *   NODE_OPTIONS=--tls-max-v1.2 npx tsx scripts/calibrage-securite.ts --markdown
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkTextSafety, isInLegalDomain, shouldBlock } from '../src/safety.js';
import { createOpenRouterClient } from '../src/llm.js';
import { createLogger } from '../src/logger.js';

interface SampleCase {
  id: string;
  expected: 'legitime' | 'dangereux';
  text: string;
}

const SAMPLE = resolve(process.cwd(), 'data', 'safety-sample.json');
const MODEL = process.env.LLM_SAFETY_MODEL ?? 'nvidia/nemotron-3.5-content-safety:free';

function loadKey(): string {
  // Le fichier .env est lu ici comme dans les autres scripts.
  try {
    const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    const match = env.match(/^OPENROUTER_API_KEY=(.*)$/m);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    /* pas de fichier .env */
  }
  return (process.env.OPENROUTER_API_KEY ?? '').trim();
}

interface Row {
  id: string;
  expected: 'legitime' | 'dangereux';
  verdict: string;
  available: boolean;
  inDomain: boolean;
  blockedAdvisory: boolean;
  blockedBlock: boolean;
  wrong: boolean;
}

async function main(): Promise<void> {
  const key = loadKey();
  if (!key) {
    console.error('OPENROUTER_API_KEY absente : rien à mesurer.');
    process.exit(2);
  }

  const { cases } = JSON.parse(readFileSync(SAMPLE, 'utf8')) as { cases: SampleCase[] };
  const client = createOpenRouterClient({
    baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    apiKey: key,
    siteUrl: process.env.OPENROUTER_SITE_URL ?? '',
    appTitle: process.env.OPENROUTER_APP_TITLE ?? 'LexCanvas',
  });
  const logger = createLogger('warn', { service: 'lexcanvas-calibrage' });

  const rows: Row[] = [];

  for (const item of cases) {
    const verdict = await checkTextSafety({
      client,
      model: MODEL,
      text: item.text,
      signal: AbortSignal.timeout(120_000),
      logger,
    });

    const inDomain = isInLegalDomain(item.text);
    const blockedAdvisory = shouldBlock(verdict, 'advisory', inDomain);
    const blockedBlock = shouldBlock(verdict, 'block', inDomain);
    // Un cas est « faux » quand le résultat contredit l'attente humaine :
    // une demande légitime bloquée, ou une demande dangereuse laissée passer.
    const wrong = item.expected === 'legitime'
      ? blockedAdvisory
      : !blockedAdvisory;

    rows.push({
      id: item.id,
      expected: item.expected,
      verdict: verdict.label,
      available: verdict.available,
      inDomain,
      blockedAdvisory,
      blockedBlock,
      wrong,
    });

    const mark = wrong ? '✗' : '·';
    console.log(
      `${mark} ${item.id.padEnd(4)} ${item.expected.padEnd(9)} verdict=${verdict.label.padEnd(9)} `
      + `domaine=${inDomain ? 'oui ' : 'non '} advisory=${blockedAdvisory ? 'bloque' : 'laisse'} `
      + `block=${blockedBlock ? 'bloque' : 'laisse'}`,
    );
  }

  const legitimate = rows.filter((row) => row.expected === 'legitime');
  const dangerous = rows.filter((row) => row.expected === 'dangereux');

  const falsePositives = legitimate.filter((row) => row.blockedAdvisory);
  const falseNegatives = dangerous.filter((row) => !row.blockedAdvisory);
  const falsePositivesBlock = legitimate.filter((row) => row.blockedBlock);
  const falseNegativesBlock = dangerous.filter((row) => !row.blockedBlock);
  const unreadable = rows.filter((row) => !row.available);

  const report = {
    model: MODEL,
    cases: rows.length,
    legitimate: legitimate.length,
    dangerous: dangerous.length,
    advisory: {
      falsePositives: falsePositives.map((row) => row.id),
      falseNegatives: falseNegatives.map((row) => row.id),
    },
    block: {
      falsePositives: falsePositivesBlock.map((row) => row.id),
      falseNegatives: falseNegativesBlock.map((row) => row.id),
    },
    unreadable: unreadable.map((row) => row.id),
    rows,
  };

  console.log('');
  console.log(`Échantillon : ${rows.length} cas (${legitimate.length} légitimes, ${dangerous.length} dangereux)`);
  console.log(`Modèle     : ${MODEL}`);
  console.log('');
  console.log(`Réglages "advisory" (par défaut) : ${falsePositives.length} bloqué(s) à tort, ${falseNegatives.length} laissé(s) passer`);
  console.log(`Réglages "block"                 : ${falsePositivesBlock.length} bloqué(s) à tort, ${falseNegativesBlock.length} laissé(s) passer`);
  console.log(`Verdicts illisibles              : ${unreadable.length}`);
  if (falsePositives.length) console.log(`Faux positifs (advisory) : ${falsePositives.map((row) => row.id).join(', ')}`);
  if (falseNegatives.length) console.log(`Faux négatifs (advisory) : ${falseNegatives.map((row) => row.id).join(', ')}`);
  if (falsePositivesBlock.length) console.log(`Faux positifs (block)     : ${falsePositivesBlock.map((row) => row.id).join(', ')}`);
  if (falseNegativesBlock.length) console.log(`Faux négatifs (block)     : ${falseNegativesBlock.map((row) => row.id).join(', ')}`);

  if (process.argv.includes('--markdown')) {
    const out = resolve(process.cwd(), 'docs', 'CALIBRAGE-SECURITE.md');
    const lines = [
      '# Calibrage du gardien de sécurité',
      '',
      `**Date** : ${new Date().toISOString().slice(0, 10)}`,
      `**Modèle** : \`${MODEL}\``,
      `**Échantillon** : \`data/safety-sample.json\` (${rows.length} cas, référence humaine)`,
      '',
      '## Résultat',
      '',
      '| Réglage | Faux positifs (légitime bloqué) | Faux négatifs (dangereux laissé passer) |',
      '|---|---|---|',
      `| \`advisory\` (défaut) | **${falsePositives.length}** ${falsePositives.map((row) => `\`${row.id}\``).join(' ')} | **${falseNegatives.length}** ${falseNegatives.map((row) => `\`${row.id}\``).join(' ')} |`,
      `| \`block\` | **${falsePositivesBlock.length}** ${falsePositivesBlock.map((row) => `\`${row.id}\``).join(' ')} | **${falseNegativesBlock.length}** ${falseNegativesBlock.map((row) => `\`${row.id}\``).join(' ')} |`,
      '',
      `Verdicts illisibles : ${unreadable.length}${unreadable.length ? ` (${unreadable.map((row) => `\`${row.id}\``).join(' ')})` : ''}.`,
      '',
      '## Détail',
      '',
      '| Cas | Attendu | Verdict | Domaine | `advisory` | `block` |',
      '|---|---|---|---|---|---|',
      ...rows.map((row) =>
        `| \`${row.id}\` | ${row.expected} | ${row.verdict} | ${row.inDomain ? 'oui' : 'non'} | ${row.blockedAdvisory ? 'bloqué' : 'laissé'} | ${row.blockedBlock ? 'bloqué' : 'laissé'} |`),
      '',
      '## Lecture',
      '',
      '- **Faux positif** : une demande légitime que le gardien a classée `unsafe`.',
      '- **Faux négatif** : une demande dangereuse que le gardien a classée `safe`.',
      '- **Domaine** : la demande contient un terme du vocabulaire juridique ou',
      '  administratif. Les cas légitimes du catalogue sont, par construction,',
      '  dans le domaine.',
      '- Un verdict illisible est compté comme « laissé passer » (le service ne',
      '  s\'arrête pas quand le gardien tombe) : il apparaît dans les faux',
      '  négatifs.',
      '',
      '## Rejouer',
      '',
      '```bash',
      'NODE_OPTIONS=--tls-max-v1.2 npx tsx scripts/calibrage-securite.ts --markdown',
      '```',
      '',
    ];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, lines.join('\n'), 'utf8');
    console.log(`\nRapport écrit : ${out}`);
  }
}

await main();
