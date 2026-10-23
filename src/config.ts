/**
 * Application configuration: reads environment variables and validates them with zod.
 * Fails fast at startup with a clear (French) message when a variable is missing or invalid.
 */
import { z } from 'zod';
import { loadEnvFile } from './env.js';

loadEnvFile();

const positiveInt = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

/**
 * Chaîne de bascule par défaut (développement). Elle n'est PAS prévue pour la
 * production : les variantes `:free` d'OpenRouter sont limitées en débit et
 * **peuvent être retirées du catalogue sans préavis** — constaté le 22/10/2026
 * avec `minimax/minimax-m3.1-flash:free`. La production doit fixer `LLM_MODELS`
 * sur les jumeaux payants (voir `.env.example`), et `npm run verif-prod` sonde
 * chaque modèle de la chaîne avant déploiement.
 */
const DEFAULT_MODELS = ['dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3.5-super-vl:free'];
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Fournisseur de modèle : OpenRouter.
  OPENROUTER_API_KEY: z
    .string()
    .min(1, 'La variable OPENROUTER_API_KEY est obligatoire (clé OpenRouter).'),
  OPENROUTER_BASE_URL: z.string().min(1).default('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: z.string().min(1).optional(),
  OPENROUTER_APP_TITLE: z.string().min(1).default('LexCanvas'),

  // Modèles : chaîne de bascule ordonnée pour la rédaction.
  LLM_MODEL: z.string().min(1).optional(),
  LLM_MODELS: z
    .string()
    .min(1)
    .default('dots-studio/dots-3-note-preview:free,nvidia/nemotron-3.5-super-vl:free'),

  // Gardien de sécurité : hors bascule, appelé séparément.
  LLM_SAFETY_MODEL: z.string().min(1).default('nvidia/nemotron-3.5-content-safety:free'),
  SAFETY_CHECK: z.enum(['0', '1']).default('1'),
  // `advisory` (défaut) : un contenu **hors du domaine juridique** est bloqué
  //   sur le verdict du gardien ; un contenu du domaine n'est jamais bloqué
  //   (le gardien se trompe trop souvent sur du droit), il est journalisé.
  // `block` : tout verdict « unsafe » bloque, y compris dans le domaine.
  // `off` : le gardien n'est jamais consulté.
  SAFETY_MODE: z.enum(['off', 'advisory', 'block']).default('advisory'),

  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  ACCESS_CODE: z.string().min(1).optional(),
  /**
   * `code` : code partagé `X-Access-Code` (mode historique).
   * `firebase` : jeton d'identité Firebase obligatoire (`Authorization: Bearer`).
   * `hybrid` : jeton Firebase ou code partagé, pour la transition du frontend.
   */
  AUTH_MODE: z.enum(['code', 'firebase', 'hybrid']).default('code'),
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  /** Chemin du fichier JSON du compte de service. Sinon, identifiants par défaut. */
  FIREBASE_SERVICE_ACCOUNT: z.string().min(1).optional(),
  /** Historiques de contrats dans Firestore (réservés aux comptes Firebase). */
  HISTORY_ENABLED: z.enum(['0', '1']).default('0'),
  HISTORY_RETENTION_DAYS: positiveInt(90, 3650),
  HISTORY_MAX_PER_USER: positiveInt(100, 1000),
  RATE_HISTORY_PER_MIN: positiveInt(60, 100000),
  MAX_STEPS: positiveInt(6, 20),
  MAX_OUTPUT_TOKENS: positiveInt(16000, 64000),
  REQUEST_TIMEOUT_MS: positiveInt(240000, 600000),
  RATE_CHAT_PER_HOUR: positiveInt(30, 100000),
  RATE_EXPORT_PER_MIN: positiveInt(10, 100000),
  MAX_BODY_BYTES: positiveInt(1048576, 67108864),
  /**
   * Nombre maximal de blocs qu'une modification ciblée a le droit de
   * toucher. Au-delà, la modification est refusée : le modèle réécrit
   * le document au lieu de modifier une clause.
   */
  MAX_EDIT_CHANGED_BLOCKS: positiveInt(4, 50),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  ALLOWED_ORIGIN: z.string().min(1).optional(),
  EXPORT_FOOTER: z.string().min(1).optional(),
  /**
   * Nombre maximal de messages de l'historique renvoyés au modèle.
   * Le premier message de l'utilisateur et le dernier sont toujours conservés.
   * Au-delà, l'historique est tronqué : le document et les messages sont
   * retransmis à chaque étape, ce qui multiplie le volume transmis.
   */
  MAX_HISTORY_MESSAGES: positiveInt(12, 30),
});

export type RawConfig = z.infer<typeof schema>;

/** Toutes les variables reconnues, pour la documentation et les tests. */
export const CONFIG_KEYS: string[] = Object.keys(schema.shape);

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  apiKey: string;
  baseUrl: string;
  siteUrl: string | null;
  appTitle: string;
  /** Chaîne de bascule de la rédaction, dans l'ordre d'essai. */
  models: string[];
  /** Modèle principal (premier de la chaîne). */
  model: string;
  safetyModel: string;
  safetyCheck: boolean;
  safetyMode: 'off' | 'advisory' | 'block';
  port: number;
  accessCode: string | null;
  authMode: 'code' | 'firebase' | 'hybrid';
  firebaseProjectId: string | null;
  firebaseServiceAccount: string | null;
  historyEnabled: boolean;
  historyRetentionDays: number;
  historyMaxPerUser: number;
  rateHistoryPerMin: number;
  maxSteps: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  rateChatPerHour: number;
  rateExportPerMin: number;
  maxBodyBytes: number;
  maxEditChangedBlocks: number;
  maxHistoryMessages: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  trustProxy: boolean;
  allowedOrigin: string | null;
  exportFooter: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function toAppConfig(raw: RawConfig): AppConfig {
  // `LLM_MODEL` (alias historique) passe en tête de la chaîne de bascule.
  const list = raw.LLM_MODELS
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  if (list.length === 0) list.push(...DEFAULT_MODELS);

  const ordered = raw.LLM_MODEL
    ? [raw.LLM_MODEL, ...list.filter((model) => model !== raw.LLM_MODEL)]
    : list;

  return {
    nodeEnv: raw.NODE_ENV,
    apiKey: raw.OPENROUTER_API_KEY,
    baseUrl: raw.OPENROUTER_BASE_URL,
    siteUrl: raw.OPENROUTER_SITE_URL ?? null,
    appTitle: raw.OPENROUTER_APP_TITLE,
    models: ordered,
    model: ordered[0]!,
    safetyModel: raw.LLM_SAFETY_MODEL,
    safetyCheck: raw.SAFETY_CHECK === '1',
    safetyMode: raw.SAFETY_MODE,
    port: raw.PORT,
    accessCode: raw.ACCESS_CODE ?? null,
    authMode: raw.AUTH_MODE,
    firebaseProjectId: raw.FIREBASE_PROJECT_ID ?? null,
    firebaseServiceAccount: raw.FIREBASE_SERVICE_ACCOUNT ?? null,
    historyEnabled: raw.HISTORY_ENABLED === '1',
    historyRetentionDays: raw.HISTORY_RETENTION_DAYS,
    historyMaxPerUser: raw.HISTORY_MAX_PER_USER,
    rateHistoryPerMin: raw.RATE_HISTORY_PER_MIN,
    maxSteps: raw.MAX_STEPS,
    maxOutputTokens: raw.MAX_OUTPUT_TOKENS,
    requestTimeoutMs: raw.REQUEST_TIMEOUT_MS,
    rateChatPerHour: raw.RATE_CHAT_PER_HOUR,
    rateExportPerMin: raw.RATE_EXPORT_PER_MIN,
    maxBodyBytes: raw.MAX_BODY_BYTES,
    maxEditChangedBlocks: raw.MAX_EDIT_CHANGED_BLOCKS,
    maxHistoryMessages: raw.MAX_HISTORY_MESSAGES,
    logLevel: raw.LOG_LEVEL,
    trustProxy: raw.TRUST_PROXY === '1',
    allowedOrigin: raw.ALLOWED_ORIGIN ?? null,
    exportFooter: raw.EXPORT_FOOTER ?? null,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    if (value === undefined) continue;
    // An empty environment variable means "not set".
    if (typeof value === 'string' && value.trim() === '') continue;
    candidate[key] = value;
  }
  const result = schema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'variable'} : ${issue.message}`)
      .join(' ; ');
    throw new ConfigError(`Configuration invalide — ${details}`);
  }
  const config = toAppConfig(result.data);

  if (config.authMode !== 'code' && !config.firebaseProjectId) {
    throw new ConfigError(
      'FIREBASE_PROJECT_ID est obligatoire avec AUTH_MODE=firebase ou AUTH_MODE=hybrid.',
    );
  }

  if (config.historyEnabled && config.authMode === 'code') {
    throw new ConfigError(
      'HISTORY_ENABLED=1 exige AUTH_MODE=firebase ou AUTH_MODE=hybrid : '
      + 'un historique doit être rattaché à un compte Firebase (uid).',
    );
  }

  // En production, aucune requête ne doit être servie sans authentification :
  // le serveur héberge la clé du fournisseur de modèle. Le mode `firebase` est
  // sûr sans ACCESS_CODE ; le mode `hybrid` avec un code est également couvert.
  if (config.nodeEnv === 'production' && config.authMode === 'code' && !config.accessCode) {
    throw new ConfigError(
      'ACCESS_CODE est obligatoire en production avec AUTH_MODE=code : sans mécanisme '
      + 'd’authentification, le quota du fournisseur de modèle est à la disposition de '
      + 'quiconque atteint le port.',
    );
  }

  return config;
}

export const CONTRACT_VERSION = '1.1';
