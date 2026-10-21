/**
 * Application configuration: reads environment variables and validates them with zod.
 * Fails fast at startup with a clear (French) message when a variable is missing or invalid.
 */
import { z } from 'zod';
import { loadEnvFile } from './env.js';

loadEnvFile();

const positiveInt = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ANTHROPIC_API_KEY: z
    .string()
    .min(1, 'La variable ANTHROPIC_API_KEY est obligatoire (clé du fournisseur de modèle).'),
  LLM_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  ACCESS_CODE: z.string().min(1).optional(),
  MAX_STEPS: positiveInt(6, 20),
  MAX_OUTPUT_TOKENS: positiveInt(8000, 64000),
  REQUEST_TIMEOUT_MS: positiveInt(120000, 600000),
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
  model: string;
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
  return {
    nodeEnv: raw.NODE_ENV,
    apiKey: raw.ANTHROPIC_API_KEY,
    model: raw.LLM_MODEL,
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
