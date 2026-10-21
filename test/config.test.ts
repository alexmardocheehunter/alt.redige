import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('config', () => {
  it('applique les valeurs par défaut', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'k' });
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.models).toEqual([
      'minimax/minimax-m3.1-flash:free',
      'nvidia/nemotron-3.5-super-vl:free',
    ]);
    expect(config.model).toBe('minimax/minimax-m3.1-flash:free');
    expect(config.safetyModel).toBe('nvidia/nemotron-3.5-content-safety:free');
    expect(config.safetyCheck).toBe(true);
    expect(config.port).toBe(3000);
    expect(config.maxSteps).toBe(6);
    expect(config.maxOutputTokens).toBe(16000);
    expect(config.requestTimeoutMs).toBe(240000);
    expect(config.rateChatPerHour).toBe(30);
    expect(config.rateExportPerMin).toBe(10);
    expect(config.maxBodyBytes).toBe(1048576);
    expect(config.accessCode).toBeNull();
    expect(config.trustProxy).toBe(false);
  });

  it('échoue vite quand OPENROUTER_API_KEY manque', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('échoue sur une variable numérique invalide', () => {
    expect(() => loadConfig({ OPENROUTER_API_KEY: 'k', PORT: 'abc' })).toThrow(ConfigError);
  });

  it('ignore les variables vides', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'k', ACCESS_CODE: '', ALLOWED_ORIGIN: '' });
    expect(config.accessCode).toBeNull();
    expect(config.allowedOrigin).toBeNull();
  });

  it('lit TRUST_PROXY=1', () => {
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('lit la chaîne de bascule LLM_MODELS', () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      LLM_MODELS: 'a/free,b/free , c/free',
    });
    expect(config.models).toEqual(['a/free', 'b/free', 'c/free']);
  });

  it('LLM_MODEL passe en tête de la chaîne', () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      LLM_MODEL: 'principal/free',
      LLM_MODELS: 'second/free,principal/free',
    });
    expect(config.models).toEqual(['principal/free', 'second/free']);
    expect(config.model).toBe('principal/free');
  });

  it('désactive le filtre de sécurité avec SAFETY_CHECK=0', () => {
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', SAFETY_CHECK: '0' }).safetyCheck).toBe(false);
    expect(loadConfig({ OPENROUTER_API_KEY: 'k', SAFETY_CHECK: '1' }).safetyCheck).toBe(true);
  });
});
