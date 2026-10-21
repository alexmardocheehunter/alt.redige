import { loadConfig, type AppConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/types.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({ ANTHROPIC_API_KEY: 'test-key' });
  return { ...base, ...overrides };
}

export function testApp(overrides: Partial<AppConfig> = {}): Hono<AppEnv> {
  const config = testConfig(overrides);
  const logger = createLogger('error');
  return createApp({ config, logger });
}

/** Reads a JSON response body without the `unknown` noise. */
export async function readJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
