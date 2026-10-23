import type { LlmClient } from '../src/llm.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import type { AccessVerifier } from '../src/middleware/auth.js';
import type { HistoryStore } from '../src/history/store.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/types.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ OPENROUTER_API_KEY: 'test-key' });
  return { ...base, ...overrides };
}

export interface TestAppOptions {
  /** Faux client OpenRouter, injecté à la place du vrai client. */
  client?: LlmClient;
  /** Vérificateur injecté : évite d'initialiser Firebase dans les tests. */
  verifier?: AccessVerifier;
  /** Stockage d'historiques injecté (faux en mémoire). */
  historyStore?: HistoryStore;
}

export function testApp(
  overrides: Partial<AppConfig> = {},
  options: TestAppOptions = {},
): Hono<AppEnv> {
  const config = testConfig(overrides);
  const logger = createLogger('error');
  return createApp({
    config,
    logger,
    client: options.client,
    verifier: options.verifier,
    historyStore: options.historyStore,
  });
}

/** Reads a JSON response body without the `unknown` noise. */
export async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Waits for a while (used by the asynchronous tests). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
