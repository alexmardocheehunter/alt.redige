import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('config', () => {
  it('applique les valeurs par défaut', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'k' });
    expect(config.model).toBe('claude-sonnet-5-5');
    expect(config.port).toBe(3000);
    expect(config.maxSteps).toBe(6);
    expect(config.maxOutputTokens).toBe(8000);
    expect(config.requestTimeoutMs).toBe(120000);
    expect(config.rateChatPerHour).toBe(30);
    expect(config.rateExportPerMin).toBe(10);
    expect(config.maxBodyBytes).toBe(1048576);
    expect(config.accessCode).toBeNull();
    expect(config.trustProxy).toBe(false);
  });

  it('échoue vite quand ANTHROPIC_API_KEY manque', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('échoue sur une variable numérique invalide', () => {
    expect(() => loadConfig({ ANTHROPIC_API_KEY: 'k', PORT: 'abc' })).toThrow(ConfigError);
  });

  it('ignore les variables vides', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'k', ACCESS_CODE: '', ALLOWED_ORIGIN: '' });
    expect(config.accessCode).toBeNull();
    expect(config.allowedOrigin).toBeNull();
  });

  it('lit TRUST_PROXY=1', () => {
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k', TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ ANTHROPIC_API_KEY: 'k', TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });
});
