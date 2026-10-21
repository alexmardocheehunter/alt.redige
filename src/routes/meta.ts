/**
 * Metadata routes: GET /api/health and GET /api/templates.
 * The health endpoint never depends on the LLM provider.
 */
import { Hono } from 'hono';
import { CONTRACT_VERSION, type AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AppEnv } from '../types.js';

export interface MetaDeps {
  config: AppConfig;
  logger: Logger;
}

export function metaRoutes({ config }: MetaDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/api/health', (c) =>
    c.json({ ok: true, contract_version: CONTRACT_VERSION, model: config.model }));

  return app;
}
