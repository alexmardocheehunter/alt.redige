/**
 * Entry point: loads the configuration, starts the HTTP server, handles a clean shutdown.
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { beginShutdown } from './runtime-state.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`ERREUR DE CONFIGURATION — ${error.message}`);
      console.error('Copiez .env.example vers .env et renseignez les variables manquantes.');
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel, { service: 'lexcanvas' });
  const app = createApp({ config, logger });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: '0.0.0.0',
  }, (info) => {
    logger.info('server_started', { port: info.port, model: config.model });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Refuse the new streams, let the running ones finish (30 s max).
    beginShutdown();
    logger.info('shutdown_started', { signal });
    server.close((err) => {
      if (err) logger.error('shutdown_error', { error: err.message });
      logger.info('shutdown_complete', { signal });
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('shutdown_forced', { signal });
      process.exit(0);
    }, 30_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
