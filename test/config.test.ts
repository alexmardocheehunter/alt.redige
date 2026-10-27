import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, ConfigError, loadConfig } from '../src/config.js';

describe('config', () => {
  it('applique les valeurs par défaut', () => {
    const config = loadConfig({ OPENROUTER_API_KEY: 'k' });
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(config.models).toEqual([
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3.5-super-vl:free',
      'google/gemma-4-31b-it:free',
    ]);
    expect(config.model).toBe('dots-studio/dots-3-note-preview:free');
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
    expect(config.authMode).toBe('code');
    expect(config.firebaseProjectId).toBeNull();
    expect(config.firebaseServiceAccount).toBeNull();
    expect(config.historyEnabled).toBe(false);
    expect(config.historyRetentionDays).toBe(90);
    expect(config.historyMaxPerUser).toBe(100);
    expect(config.rateHistoryPerMin).toBe(60);
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

  it('lit une liste d’origines autorisées et PUBLIC_API_BASE', () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      ALLOWED_ORIGIN: ' https://altredige.web.app , https://altredige.firebaseapp.com ',
      PUBLIC_API_BASE: 'https://lexcanvas-657enh5l5q-ew.a.run.app',
    });
    expect(config.allowedOrigins).toEqual([
      'https://altredige.web.app',
      'https://altredige.firebaseapp.com',
    ]);
    expect(config.allowedOrigin).toBe('https://altredige.web.app');
    expect(config.publicApiBase).toBe('https://lexcanvas-657enh5l5q-ew.a.run.app');
  });

  it('refuse une PUBLIC_API_BASE qui n’est pas une URL', () => {
    expect(() => loadConfig({
      OPENROUTER_API_KEY: 'k',
      PUBLIC_API_BASE: 'pas-une-url',
    })).toThrow(ConfigError);
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

  it('exige ACCESS_CODE en production avec le mode code', () => {
    expect(() => loadConfig({ OPENROUTER_API_KEY: 'k', NODE_ENV: 'production' })).toThrow(ConfigError);
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      NODE_ENV: 'production',
      ACCESS_CODE: 'un-code-de-production',
    });
    expect(config.accessCode).toBe('un-code-de-production');
  });

  it('accepte le mode firebase en production sans ACCESS_CODE', () => {
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      NODE_ENV: 'production',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'altredige',
    });
    expect(config.authMode).toBe('firebase');
    expect(config.accessCode).toBeNull();
  });

  it('exige un projet Firebase pour les modes firebase et hybrid', () => {
    expect(() => loadConfig({ OPENROUTER_API_KEY: 'k', AUTH_MODE: 'firebase' })).toThrow(ConfigError);
    expect(() => loadConfig({ OPENROUTER_API_KEY: 'k', AUTH_MODE: 'hybrid' })).toThrow(ConfigError);
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      AUTH_MODE: 'hybrid',
      FIREBASE_PROJECT_ID: 'altredige',
    });
    expect(config.authMode).toBe('hybrid');
  });

  it('refuse les historiques avec un code partagé', () => {
    expect(() => loadConfig({
      OPENROUTER_API_KEY: 'k',
      HISTORY_ENABLED: '1',
    })).toThrow(ConfigError);
    const config = loadConfig({
      OPENROUTER_API_KEY: 'k',
      AUTH_MODE: 'firebase',
      FIREBASE_PROJECT_ID: 'altredige',
      HISTORY_ENABLED: '1',
    });
    expect(config.historyEnabled).toBe(true);
  });

  it('documente toutes les variables reconnues dans .env.example', () => {
    // Une variable absente de .env.example est une variable que personne ne
    // pensera à régler : le fichier est la référence d'exploitation.
    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    // Une variable peut être documentée en commentaire (alias historique) :
    // `# LLM_MODEL=...` compte comme documentée.
    const missing = CONFIG_KEYS.filter((key) => !new RegExp(`^#?\\s*${key}=`, 'm').test(example));
    expect(missing).toEqual([]);
  });

  it('recommande le mode advisory dans .env.example', () => {
    // Le mode par défaut doit être celui qui est mesuré comme sûr : `block`
    // bloque une demande légitime sur 20 (docs/CALIBRAGE-SECURITE.md).
    const example = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');
    expect(example).toMatch(/^SAFETY_MODE=advisory$/m);
  });
});
