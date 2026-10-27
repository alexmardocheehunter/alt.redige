/**
 * Vérification de production — utilisable comme porte avant déploiement.
 *
 * Deux volets :
 *  1. **configuration** : mode d'authentification, politique de modèles
 *     gratuits uniquement, gardien de sécurité et limites ; les écarts
 *     importants sont signalés avec la correction ;
 *  2. **sondes réelles** : chaque modèle de la chaîne et le gardien de sécurité
 *     sont appelés (un jeton), puis le serveur en cours d'exécution est
 *     interrogé (santé, catalogue, refus sans authentification, export Word).
 *
 * Aucun contenu de contrat ni de message n'est affiché ou journalisé : les
 * sondes n'envoient qu'un mot.
 *
 * Usage :
 *   npm run verif-prod
 *   npm run verif-prod -- --url https://lexcanvas.exemple.ci
 *   npm run verif-prod -- --url https://lexcanvas.exemple.ci --token <idToken>
 *   npm run verif-prod -- --sans-serveur
 */
import { loadConfig, ConfigError, type AppConfig } from '../src/config.js';
import { createOpenRouterClient } from '../src/llm.js';

interface Check {
  label: string;
  ok: boolean;
  /** Un échec bloquant interdit la mise en production. */
  blocking: boolean;
  detail: string;
}

const checks: Check[] = [];
const check = (label: string, ok: boolean, detail: string, blocking = true): void => {
  checks.push({ label, ok, blocking, detail });
};

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const baseUrl = urlIndex === -1 ? 'http://localhost:3123' : args[urlIndex + 1] ?? '';
const skipServer = args.includes('--sans-serveur');
const tokenIndex = args.indexOf('--token');
const bearerToken = tokenIndex === -1 ? '' : args[tokenIndex + 1] ?? '';

let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\nCONFIGURATION REFUSÉE — ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

console.log('\n═══════════ Vérification de production — LexCanvas ═══════════\n');

/* ─── 1. Configuration ─── */

console.log('─ Configuration ─\n');

check(
  'NODE_ENV',
  config.nodeEnv === 'production',
  config.nodeEnv === 'production'
    ? 'production (HSTS actif)'
    : `⚠ ${config.nodeEnv} — à passer à production sur le serveur de production`,
  false,
);

const code = config.accessCode ?? '';
const codeRequired = config.authMode === 'code';
check(
  'ACCESS_CODE',
  !codeRequired || code.length >= 16,
  code.length === 0
    ? codeRequired
      ? 'absent : le quota du fournisseur serait ouvert à quiconque atteint le port'
      : `absent — AUTH_MODE=${config.authMode} : le jeton Firebase est exigé`
    : code.length >= 16
      ? `défini (${code.length} caractères)`
      : `trop court (${code.length} caractères) : utilisez 32 caractères aléatoires`,
  codeRequired,
);

check(
  'Authentification',
  config.authMode !== 'code',
  `AUTH_MODE=${config.authMode}${config.authMode === 'code' ? ' — code partagé, pas d\'identité individuelle' : ' — identité Firebase'}`,
  false,
);

const paid = config.models.filter((model) => !model.endsWith(':free'));
check(
  'Politique modèles',
  paid.length === 0,
  paid.length === 0
    ? `chaîne 100 % gratuite (${config.models.length} modèles) — débit limité, bascule indispensable`
    : `modèles payants détectés (${paid.join(', ')}) alors que la politique est à gratuit uniquement`,
  false,
);

check(
  'Chaîne de bascule',
  config.models.length >= 2,
  config.models.length >= 2
    ? `${config.models.length} modèles`
    : 'un seul modèle : aucune bascule possible si le fournisseur tombe',
  false,
);

check(
  'Gardien de sécurité',
  config.safetyCheck && config.safetyMode !== 'off',
  config.safetyCheck
    ? `actif, mode « ${config.safetyMode} »${config.safetyMode === 'block' ? ' — déconseillé : bloque 1 demande légitime sur 20' : ''}`
    : 'désactivé (SAFETY_CHECK=0)',
  false,
);

check(
  'Clé OpenRouter',
  config.apiKey.length > 20,
  `présente (${config.apiKey.slice(0, 8)}…${config.apiKey.slice(-4)}, ${config.apiKey.length} caractères)`,
);

check(
  'Flux SSE',
  config.requestTimeoutMs >= 180_000,
  `${Math.round(config.requestTimeoutMs / 1000)} s — un contrat complet dépasse 120 s : ne pas descendre sous 180 s`,
  false,
);

check(
  'Limites de débit',
  config.rateChatPerHour > 0 && config.rateExportPerMin > 0,
  `${config.rateChatPerHour} messages/h, ${config.rateExportPerMin} exports/min par identité`,
  false,
);

check(
  'Proxy inverse',
  true,
  config.trustProxy
    ? 'TRUST_PROXY=1 : l\'IP client est lue dans X-Forwarded-For'
    : 'TRUST_PROXY=0 : à passer à 1 derrière un proxy (sinon tous les utilisateurs partagent le quota de l\'IP du proxy)',
  false,
);

for (const item of checks) {
  const mark = item.ok ? '  ok  ' : item.blocking ? ' ☒ ' : 'attention';
  console.log(`[${mark}] ${item.label.padEnd(20)} ${item.detail}`);
}

/* ─── 2. Sondes du fournisseur ─── */

const client = createOpenRouterClient({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  siteUrl: config.siteUrl,
  appTitle: config.appTitle,
});

const probe = async (model: string): Promise<{ ok: boolean; detail: string }> => {
  const started = Date.now();
  try {
    const response = await client.fetchImpl(`${client.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: client.headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const elapsed = Date.now() - started;
    if (!response.ok) {
      const body = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
      return { ok: false, detail: `HTTP ${response.status} — ${body}` };
    }
    await response.text();
    return { ok: true, detail: `répond en ${elapsed} ms` };
  } catch (error) {
    return {
      ok: false,
      detail: `${error instanceof Error ? error.name : 'erreur'} après ${Date.now() - started} ms`,
    };
  }
};

console.log('\n─ Sondes du fournisseur (1 jeton par appel) ─\n');

const modelResults = await Promise.all(config.models.map(async (model) => ({
  model,
  result: await probe(model),
})));

let firstModelOk = false;
for (const [index, item] of modelResults.entries()) {
  if (item.result.ok && index === 0) firstModelOk = true;
  const mark = item.result.ok ? '  ok  ' : index === 0 ? ' ☒ ' : 'attention';
  console.log(`[${mark}] ${item.model.padEnd(44)} ${item.result.detail}`);
}
check(
  'Modèle principal joignable',
  firstModelOk,
  firstModelOk
    ? 'le premier modèle de la chaîne a répondu'
    : 'le modèle principal n\'a pas répondu : vérifiez la clé, les identifiants de modèle et le réseau',
  true,
);

if (config.safetyCheck) {
  const safety = await probe(config.safetyModel);
  console.log(`[${safety.ok ? '  ok  ' : 'attention'}] ${config.safetyModel.padEnd(44)} ${safety.detail}`);
  check(
    'Gardien joignable',
    safety.ok,
    safety.ok
      ? 'le gardien a répondu'
      : 'le gardien ne répond pas : le serveur laisse passer sans verdict (safety_unavailable)',
    false,
  );
}

/* ─── 3. Sondes du serveur en cours ─── */

if (!skipServer && baseUrl) {
  console.log(`\n─ Serveur ${baseUrl} ─\n`);

  const get = async (path: string, headers: Record<string, string> = {}) => {
    try {
      const response = await fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(20_000) });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      return { status: 0, body: error instanceof Error ? error.message : String(error) };
    }
  };

  const health = await get('/api/health');
  const healthOk = health.status === 200 && health.body.includes('"ok":true');
  console.log(`[${healthOk ? '  ok  ' : 'attention'}] GET /api/health        ${health.status} ${health.body.slice(0, 90)}`);
  check('Serveur joignable', healthOk, healthOk ? baseUrl : `aucune réponse de ${baseUrl} (serveur arrêté ?)`, false);

  const authHeaders: Record<string, string> = bearerToken
    ? { Authorization: `Bearer ${bearerToken}` }
    : code
      ? { 'X-Access-Code': code }
      : {};
  const hasAuth = Object.keys(authHeaders).length > 0;

  if (healthOk) {
    const templates = await get('/api/templates', authHeaders);
    const count = (templates.body.match(/"id":/g) ?? []).length;
    console.log(`[${templates.status === 200 ? '  ok  ' : 'attention'}] GET /api/templates     ${templates.status} ${count} modèle(s) de contrat`);

    if (hasAuth) {
      const refused = await get('/api/templates');
      const refusedOk = refused.status === 401;
      console.log(`[${refusedOk ? '  ok  ' : ' ☒ '}] sans authentification ${refused.status} ${refused.body.slice(0, 70)}`);
      check('Refus sans authentification', refusedOk, refusedOk ? '401 attendu' : 'l\'authentification n\'est pas exigée', true);
    } else {
      const message = 'aucun code ni jeton fourni : utilisez --token <idToken> pour les sondes authentifiées';
      console.log(`[attention] sondes authentifiées ${message}`);
      check('Sondes authentifiées', false, message, false);
    }

    if (hasAuth) {
      const markdown = '# Contrat de vérification\n\n## Article 1 — Objet\n\nVérification technique.\n';
      try {
        const response = await fetch(`${baseUrl}/api/export/docx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ markdown, title: 'Contrat de vérification', version: 1 }),
          signal: AbortSignal.timeout(30_000),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        const isDocx = response.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b;
        console.log(`[${isDocx ? '  ok  ' : ' ☒ '}] POST /api/export/docx  ${response.status} ${bytes.length} octets${isDocx ? ' (.docx valide)' : ''}`);
        check('Export Word', isDocx, isDocx ? 'fichier .docx produit' : 'l\'export n\'a pas produit de .docx valide');
      } catch (error) {
        console.log(`[ ☒ ] POST /api/export/docx  ${error instanceof Error ? error.message : String(error)}`);
        check('Export Word', false, 'export injoignable');
      }
    }
  }
}

/* ─── Verdict ─── */

const blocking = checks.filter((item) => !item.ok && item.blocking);
const warnings = checks.filter((item) => !item.ok && !item.blocking);

console.log('\n═══════════════════════════════════════════════════════════════\n');
if (blocking.length === 0) {
  console.log(`Verdict : PRÊT${warnings.length > 0 ? ` (${warnings.length} point(s) d'attention)` : ''}.`);
  for (const item of warnings) console.log(`  ⚠ ${item.label} : ${item.detail}`);
  console.log('');
  process.exit(0);
}

console.log(`Verdict : NON PRÊT — ${blocking.length} point(s) bloquant(s) :`);
for (const item of blocking) console.log(`  ✗ ${item.label} : ${item.detail}`);
for (const item of warnings) console.log(`  ⚠ ${item.label} : ${item.detail}`);
console.log('');
process.exit(1);