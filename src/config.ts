/**
 * Application configuration: reads environment variables and validates them with zod.
 * Fails fast at startup with a clear (French) message when a variable is missing or invalid.
 */
import { z } from 'zod';
import { loadEnvFile } from './env.js';

loadEnvFile();

const positiveInt = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

const DEFAULT_MODELS = ['minimax/minimax-m3.1-flash:free', 'nvidia/nemotron-3.5-super-vl:free'];
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
    .default('minimax/minimax-m3.1-flash:free,nvidia/nemotron-3.5-super-vl:free'),

  // Gardien de sécurité : hors bascule, appelé séparément.
  LLM_SAFETY_MODEL: z.string().min(1).default('nvidia/nemotron-3.5-content-safety:free'),
  SAFETY_CHECK: z.enum(['0', '1']).default('1'),
  // `block` : une demande hors du domaine juridique est bloquée sur le verdict.
  // `advisory` : le verdict est journalisé, rien n'est bloqué.
  SAFETY_MODE: z.enum(['off', 'advisory', 'block']).default('block'),

  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  ACCESS_CODE: z.string().min(1).optional(),
  MAX_STEPS: positiveInt(6, 20),
  MAX_OUTPUT_TOKENS: positiveInt(16000, 64000),
  REQUEST_TIMEOUT_MS: positiveInt(240000, 600000),
  RATE_CHAT_PER_HOUR: positiveInt(30, 100000),
  RATE_EXPORT_PER_MIN: positiveInt(10, 100000),
  MAX_BODY_BYTES: positiveInt(1048576, 67108864),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  ALLOWED_ORIGIN: z.string().min(1).optional(),
  EXPORT_FOOTER: z.string().min(1).optional(),
});

export type RawConfig = z.infer<typeof schema>;

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
  maxSteps: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  rateChatPerHour: number;
  rateExportPerMin: number;
  maxBodyBytes: number;
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
    maxSteps: raw.MAX_STEPS,
    maxOutputTokens: raw.MAX_OUTPUT_TOKENS,
    requestTimeoutMs: raw.REQUEST_TIMEOUT_MS,
    rateChatPerHour: raw.RATE_CHAT_PER_HOUR,
    rateExportPerMin: raw.RATE_EXPORT_PER_MIN,
    maxBodyBytes: raw.MAX_BODY_BYTES,
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
  return toAppConfig(result.data);
}

export const CONTRACT_VERSION = '1.0';
