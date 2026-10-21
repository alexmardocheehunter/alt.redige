/**
 * Evaluation runner — `npm run eval`.
 *
 * Calls the real endpoint with the real model (costly: never run in CI by
 * default). Without `--smoke`, OPENROUTER_API_KEY must be set.
 *
 * Usage:
 *   npm run eval                 # real model — the only conclusive run
 *   npm run eval -- --smoke      # scripted model: checks the harness only,
 *                                 # does NOT count as a successful evaluation
 *   npm run eval -- --scenario=04-edition-cible
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadEnvFile } from '../src/env.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import { TemplateStore } from '../src/templates.js';
import type { Expectation, Scenario, ScenarioTurn } from './types.js';
import type { ContractTemplate } from '../src/templates.js';
import {
  checkChatText,
  checkExport,
  checkNoInventedFacts,
  checkSubset,
  checkUnchangedSections,
  countChangedBlocks,
  countChangedSections,
  countQuestions,
  type CheckResult,
} from './assertions.js';

const SCENARIOS_DIR = resolve(process.cwd(), 'evals', 'scenarios');
const FIXTURES_DIR = resolve(process.cwd(), 'evals', 'fixtures');

interface TurnObservation {
  chat: string;
  canvasSets: Array<{
    mode: 'create' | 'edit';
    markdown: string;
    version: number;
    edits_applied?: number;
    placeholders: number;
  }>;
  toolCalls: Array<{ name: string; input: any }>;
  questions: number;
}

export interface ScenarioResult {
  id: string;
  name: string;
  ok: boolean;
  checks: CheckResult[];
  error?: string;
  durationMs: number;
  /** Nombre de relances dues à un échec de transport. */
  retries?: number;
}

/* ------------------------------------------------------------------ */
/* Chargement des scénarios                                            */
/* ------------------------------------------------------------------ */

export function loadScenarios(directory: string = SCENARIOS_DIR): Scenario[] {
  const fixtures: Record<string, string> = {
    BASE_CONTRACT: readFileSync(resolve(FIXTURES_DIR, 'base-contract.md'), 'utf8'),
    BASE_CONTRACT_PARTIES: readFileSync(resolve(FIXTURES_DIR, 'base-contract-parties.md'), 'utf8'),
    BASE_CONTRACT_NEUTRAL: readFileSync(resolve(FIXTURES_DIR, 'base-contract-neutral.md'), 'utf8'),
    BASE_CONTRACT_LOYER_90000: readFileSync(resolve(FIXTURES_DIR, 'base-contract-loyer-90000.md'), 'utf8'),
  };

  const files = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  const scenarios: Scenario[] = [];

  for (const file of files) {
    const raw = JSON.parse(readFileSync(resolve(directory, file), 'utf8')) as Record<string, unknown>;
    let json = JSON.stringify(raw);
    for (const [key, value] of Object.entries(fixtures)) {
      json = json.split(`{{${key}}}`).join(JSON.stringify(value).slice(1, -1));
    }
    scenarios.push(JSON.parse(json) as Scenario);
  }

  return scenarios;
}

/* ------------------------------------------------------------------ */
/* Exécution                                                           */
/* ------------------------------------------------------------------ */

interface RunOptions {
  dryRun: boolean;
  logger: ReturnType<typeof createLogger>;
}

function parseSse(payload: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const block of payload.split(/\n\n/)) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    let event = 'message';
    let data = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      out.push({ event, data: JSON.parse(data) });
    } catch {
      out.push({ event, data });
    }
  }
  return out;
}

async function runTurn(
  app: ReturnType<typeof createApp>,
  turn: ScenarioTurn,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  document: { markdown: string; version: number } | null,
  toolCalls: Array<{ name: string; input: any }>,
): Promise<TurnObservation> {
  history.push({ role: 'user', content: turn.user });

  const startIndex = toolCalls.length;
  const res = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: history,
      document,
      contract_type: turn.contract_type ?? null,
    }),
  });

  const payload = await res.text();
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} — ${payload.slice(0, 200)}`);
  }

  const events = parseSse(payload);
  let chat = '';
  const canvasSets: TurnObservation['canvasSets'] = [];

  for (const event of events) {
    if (event.event === 'text_delta') chat += event.data.text;
    else if (event.event === 'canvas_set') {
      canvasSets.push({
        mode: event.data.mode,
        markdown: event.data.markdown,
        version: event.data.version,
        edits_applied: event.data.edits_applied,
        placeholders: event.data.validation?.placeholders ?? 0,
      });
    } else if (event.event === 'error') {
      throw new Error(`Flux en erreur : ${event.data.code} — ${event.data.message}`);
    }
  }

  return { chat, canvasSets, toolCalls: toolCalls.slice(startIndex), questions: countQuestions(chat) };
}

/* ------------------------------------------------------------------ */
/* Assertions par tour                                                 */
/* ------------------------------------------------------------------ */

async function checkTurn(
  expectation: Expectation,
  observation: TurnObservation,
  documentBefore: string | null,
  documentAfter: string | null,
  userMessages: string[],
  template: ContractTemplate | null,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  if (expectation.expect_canvas === true) {
    checks.push({
      name: 'Canvas créé',
      ok: observation.canvasSets.length > 0,
      ...(observation.canvasSets.length === 0 ? { detail: 'aucun canvas_set reçu' } : {}),
    });
  }

  if (expectation.expect_canvas === false) {
    checks.push({
      name: 'Aucun canvas',
      ok: observation.canvasSets.length === 0,
      ...(observation.canvasSets.length > 0 ? { detail: 'un canvas_set a été reçu' } : {}),
    });
  }

  if (expectation.canvas_modes) {
    const modes = observation.canvasSets.map((set) => set.mode);
    const expected = expectation.canvas_modes;
    // Les modes attendus doivent ouvrir le flux ; l'agent peut ensuite
    // peaufiner le document (un `edit` après un `create` est acceptable).
    const ok = modes.length >= expected.length
      && expected.every((mode, index) => modes[index] === mode);
    checks.push({
      name: 'Modes du Canvas',
      ok,
      ...(ok ? {} : { detail: `attendu ${expected.join(', ')} — reçu ${modes.join(', ') || 'rien'}` }),
    });
  }

  if (expectation.max_questions !== undefined) {
    checks.push({
      name: 'Nombre de questions',
      ok: observation.questions <= expectation.max_questions,
      ...(observation.questions <= expectation.max_questions
        ? {}
        : { detail: `${observation.questions} questions (maximum ${expectation.max_questions})` }),
    });
  }

  if (expectation.min_questions !== undefined) {
    checks.push({
      name: 'Nombre de questions (minimum)',
      ok: observation.questions >= expectation.min_questions,
      ...(observation.questions >= expectation.min_questions
        ? {}
        : { detail: `${observation.questions} questions (minimum ${expectation.min_questions})` }),
    });
  }

  for (const expectedCall of expectation.tool_calls ?? []) {
    const calls = observation.toolCalls.filter((call) => call.name === expectedCall.name);
    const expectedCount = expectedCall.count ?? 1;
    let ok = expectedCall.count_min !== undefined
      ? calls.length >= expectedCall.count_min
      : calls.length === expectedCount;
    let detail = '';

    if (!ok) {
      detail = `${expectedCall.name} : ${calls.length} appel(s) au lieu de ${expectedCount}`;
    }

    if (ok && expectedCall.edits !== undefined) {
      const edits = calls.reduce(
        (total, call) => total + (Array.isArray(call.input?.edits) ? call.input.edits.length : 0),
        0,
      );
      ok = edits === expectedCall.edits;
      if (!ok) detail = `${expectedCall.name} : ${edits} edit(s) au lieu de ${expectedCall.edits}`;
    }

    if (ok && expectedCall.replace !== undefined) {
      const replace = calls.some((call) => call.input?.replace === true);
      ok = replace === expectedCall.replace;
      if (!ok) detail = `${expectedCall.name} : replace=${replace}`;
    }

    checks.push({ name: `Outil ${expectedCall.name}`, ok, ...(detail ? { detail } : {}) });
  }

  if (expectation.edits_applied !== undefined) {
    const applied = observation.canvasSets.at(-1)?.edits_applied;
    checks.push({
      name: 'Modifications appliquées',
      ok: applied === expectation.edits_applied,
      ...(applied === expectation.edits_applied
        ? {}
        : { detail: `${applied ?? 'aucun'} au lieu de ${expectation.edits_applied}` }),
    });
  }

  const lastSet = observation.canvasSets.at(-1);

  if (expectation.placeholders_min !== undefined || expectation.placeholders_max !== undefined) {
    const placeholders = lastSet?.placeholders ?? 0;
    const okMin = expectation.placeholders_min === undefined || placeholders >= expectation.placeholders_min;
    const okMax = expectation.placeholders_max === undefined || placeholders <= expectation.placeholders_max;
    checks.push({
      name: 'Espaces réservés',
      ok: okMin && okMax,
      ...(okMin && okMax ? {} : { detail: `${placeholders} espace(s) réservés` }),
    });
  }

  if (expectation.chat_max_length !== undefined) {
    const check = checkChatText(observation.chat, expectation.chat_max_length);
    checks.push(check);
  }

  for (const needle of expectation.chat_contains ?? []) {
    checks.push({
      name: 'Chat contient le texte attendu',
      ok: observation.chat.includes(needle),
      ...(observation.chat.includes(needle) ? {} : { detail: `« ${needle} » absent` }),
    });
  }

  for (const needle of expectation.chat_not_contains ?? []) {
    checks.push({
      name: 'Chat ne contient pas le texte interdit',
      ok: !observation.chat.includes(needle),
      ...(observation.chat.includes(needle) ? {} : { detail: `« ${needle} » présent` }),
    });
  }

  if (expectation.chat_no_legal_citation) {
    const citations = observation.chat.match(/\barticle\s+\d+|\barticles\s+\d+|\bloi\s+n[°o]\s*\d+/gi) ?? [];
    checks.push({
      name: 'Aucune citation juridique dans le chat',
      ok: citations.length === 0,
      ...(citations.length ? { detail: citations.join(', ') } : {}),
    });
  }

  if (lastSet) {
    for (const needle of expectation.document_contains ?? []) {
      checks.push({
        name: 'Document contient le texte attendu',
        ok: lastSet.markdown.includes(needle),
        ...(lastSet.markdown.includes(needle) ? {} : { detail: `« ${needle} » absent` }),
      });
    }

    for (const needle of expectation.document_not_contains ?? []) {
      checks.push({
        name: 'Document ne contient pas le texte interdit',
        ok: !lastSet.markdown.includes(needle),
        ...(lastSet.markdown.includes(needle) ? {} : { detail: `« ${needle} » présent` }),
      });
    }

    if (expectation.no_forbidden_construct !== false) {
      checks.push(checkSubset(lastSet.markdown));
    }

    if (expectation.no_invented_facts) {
      checks.push(checkNoInventedFacts(lastSet.markdown, userMessages, template ?? null));
    }

    if (expectation.no_legal_citation) {
      const citations = lastSet.markdown.match(/\barticle\s+\d+|\barticles\s+\d+/gi) ?? [];
      const legalNotes = template?.legal_notes ?? [];
      const unknown = citations.filter((citation) => !legalNotes.some((note) => note.includes(citation)));
      checks.push({
        name: 'Aucune citation juridique inventée',
        ok: unknown.length === 0,
        ...(unknown.length ? { detail: unknown.join(', ') } : {}),
      });
    }
  }

  if (expectation.unchanged_sections && documentBefore && documentAfter) {
    checks.push(checkUnchangedSections(documentBefore, documentAfter, expectation.unchanged_sections));
  }

  if (expectation.max_changed_sections !== undefined && documentBefore && documentAfter) {
    const changed = countChangedSections(documentBefore, documentAfter);
    checks.push({
      name: 'Nombre de sections modifiées',
      ok: changed <= expectation.max_changed_sections,
      ...(changed <= expectation.max_changed_sections
        ? {}
        : { detail: `${changed} section(s) modifiée(s) au lieu de ${expectation.max_changed_sections}` }),
    });
  }

  if (expectation.max_changed_blocks !== undefined && documentBefore && documentAfter) {
    // Comparaison par blocs (séparés par une ligne vide) : c'est la méthode
    // décrite par la spécification, robuste à un renumérotage d'articles.
    const changed = countChangedBlocks(documentBefore, documentAfter);
    checks.push({
      name: 'Blocs non concernés inchangés',
      ok: changed.changed <= expectation.max_changed_blocks,
      ...(changed.changed <= expectation.max_changed_blocks
        ? {}
        : {
          detail:
            `${changed.changed} bloc(s) modifié(s) au lieu de ${expectation.max_changed_blocks} `
            + `(${changed.added} ajout(s), ${changed.removed} retiré(s))`,
        }),
    });
  }

  if (expectation.document_preserved && lastSet) {
    checks.push({
      name: 'Texte écrit à la main conservé',
      ok: lastSet.markdown.includes(expectation.document_preserved),
      ...(lastSet.markdown.includes(expectation.document_preserved)
        ? {}
        : { detail: `« ${expectation.document_preserved} » absent du document final` }),
    });
  }

  return checks;
}

/* ------------------------------------------------------------------ */
/* Scénario complet                                                    */
/* ------------------------------------------------------------------ */

export async function runScenario(
  scenario: Scenario,
  options: RunOptions,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];
  const logger = options.logger.child({ scenario: scenario.id });

  let config;
  try {
    config = loadConfig();
  } catch {
    // No key: the run is a dry run, the client is scripted.
    config = loadConfig({ ...process.env, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? 'dry-run' });
  }

  const templates = TemplateStore.load();
  const template = templates.get('bail-habitation') ?? null;

  let client: any;
  if (options.dryRun) {
    const { createDryRunClient } = await import('./dry-run.js');
    client = createDryRunClient(scenario);
  } else {
    const { createOpenRouterClient } = await import('../src/llm.js');
    client = createOpenRouterClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      siteUrl: config.siteUrl,
      appTitle: config.appTitle,
    });
  }

  const app = createApp({
    config,
    logger,
    templates,
    client,
    onToolCall: (name, input) => {
      toolCalls.push({ name, input });
    },
  });

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const toolCalls: Array<{ name: string; input: any }> = [];
  const userMessages: string[] = [];
  let document: { markdown: string; version: number } | null = null;

  try {
    for (const turn of scenario.turns) {
      // The document the client actually sends is the reference for the "targeted edit" check.
      const sentDocument = turn.document ?? document;
      const documentBefore = sentDocument?.markdown ?? null;
      userMessages.push(turn.user);

      const observation = await runTurn(app, turn, history, sentDocument, toolCalls);
      history.push({ role: 'assistant', content: observation.chat });

      const lastSet = observation.canvasSets.at(-1);
      if (lastSet) {
        document = { markdown: lastSet.markdown, version: lastSet.version };
      } else if (turn.document) {
        document = turn.document;
      }

      const turnChecks = await checkTurn(
        turn.expect ?? {},
        observation,
        documentBefore,
        document?.markdown ?? null,
        userMessages,
        template,
      );
      checks.push(...turnChecks);

      const failed = turnChecks.filter((check) => !check.ok);
      if (failed.length > 0) {
        logger.info('scenario_turn_failed', { scenario: scenario.id, failures: failed.length });
      }
    }

    // The export is checked on the final document.
    if (document) {
      const exportCheck = await checkExport(document.markdown);
      checks.push(exportCheck);
      if (exportCheck.skipped && exportCheck.skipped.length > 0) {
        logger.info('export_checks_skipped', { skipped: exportCheck.skipped.join(', ') });
      }
    }
  } catch (error) {
    return {
      id: scenario.id,
      name: scenario.name,
      ok: false,
      checks,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    id: scenario.id,
    name: scenario.name,
    ok: checks.every((check) => check.ok),
    checks,
    durationMs: Date.now() - startedAt,
  };
}

/** Un échec de transport (réseau, quota, délai) : le scénario peut être rejoué. */
export function isTransportFailure(result: ScenarioResult): boolean {
  if (!result.error) return false;
  return /Flux en erreur|HTTP \d{3}/.test(result.error)
    && /llm_unavailable|llm_error|timeout|truncated/.test(result.error);
}

async function runScenarioWithRetries(
  scenario: Scenario,
  options: RunOptions,
  retries: number,
): Promise<ScenarioResult> {
  let result = await runScenario(scenario, options);

  for (let attempt = 1; attempt <= retries && isTransportFailure(result); attempt += 1) {
    options.logger.info('scenario_retry', {
      scenario: scenario.id,
      attempt,
      error: result.error,
    });
    result = await runScenario(scenario, options);
    result.retries = attempt;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Point d’entrée                                                       */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // `--smoke` (ou `--dry-run`, alias) : modèle scripté. Ce mode vérifie le
  // harnais, PAS le comportement du modèle : il ne compte jamais comme une
  // réussite. Seule l'exécution contre le vrai modèle est concluante.
  const smoke = args.includes('--smoke') || args.includes('--dry-run');
  const filter = args.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length);

  // The key may come from .env.
  loadEnvFile();

  const logger = createLogger(smoke ? 'warn' : 'info', { service: 'lexcanvas-eval' });
  const scenarios = loadScenarios().filter((scenario) => !filter || scenario.id.includes(filter));

  if (scenarios.length === 0) {
    console.error('Aucun scénario trouvé.');
    process.exit(1);
  }

  if (!smoke && !process.env.OPENROUTER_API_KEY) {
    console.error(
      'OPENROUTER_API_KEY est absente : les scénarios ne peuvent pas être exécutés contre le vrai modèle.\n' +
      'Renseignez la clé dans .env, ou utilisez « npm run eval -- --smoke » pour vérifier le harnais sans modèle.',
    );
    process.exit(2);
  }

  if (smoke) {
    console.log(
      '\n*** MODE SMOKE (modèle scripté) ***\n'
      + 'Les réponses du modèle sont rejouées depuis les fichiers de scénario : ce mode\n'
      + 'vérifie que le harnais fonctionne, il ne mesure PAS le comportement du modèle.\n'
      + 'Un résultat « SMOKE » ne vaut pas une évaluation réussie. Seul « npm run eval »\n'
      + 'contre le vrai modèle est concluant.\n',
    );
  }

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const result = await runScenarioWithRetries(scenario, { dryRun: smoke, logger }, smoke ? 0 : 2);
    results.push(result);
    const status = result.ok ? (smoke ? 'SMOKE' : 'OK  ') : 'ÉCHEC';
    const retried = result.retries ? ` [${result.retries} relance(s)]` : '';
    console.log(`${status}  ${scenario.id}  ${scenario.name}  (${result.durationMs} ms)${retried}`);
    for (const check of result.checks.filter((item) => !item.ok)) {
      console.log(`        ✗ ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    if (result.error) console.log(`        ✗ erreur : ${result.error}`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    smoke
      ? `\n${results.length - failed.length}/${results.length} scénario(s) exécuté(s) en mode smoke — NON CONCLUANT.`
      : `\n${results.length - failed.length}/${results.length} scénario(s) au vert (modèle réel).`,
  );

  if (failed.length > 0) {
    console.log('Scénarios en échec :');
    for (const result of failed) console.log(`  - ${result.id} : ${result.name}`);
    process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js');
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
