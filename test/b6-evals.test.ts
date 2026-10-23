import { describe, expect, it } from 'vitest';
import { loadScenarios, runScenario } from '../evals/run.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('error');

describe('B6 — évaluations', () => {
  it('charge 10 scénarios', () => {
    const scenarios = loadScenarios();
    expect(scenarios).toHaveLength(10);
    for (const scenario of scenarios) {
      expect(scenario.id).toBeTruthy();
      expect(scenario.name).toBeTruthy();
      expect(scenario.turns.length).toBeGreaterThan(0);
      expect(scenario.turns.at(-1)?.user).toBeTruthy();
    }
  });

  it('couvre les 10 scénarios minimaux de la spécification', () => {
    const ids = loadScenarios().map((scenario) => scenario.id);
    expect(ids).toEqual([
      '01-demande-complete',
      '02-demande-vague',
      '03-parties-inconnues',
      '04-edition-cible',
      '05-deux-modifications',
      '06-edition-manuelle',
      '07-recommence-tout',
      '08-type-hors-catalogue',
      '09-base-legale',
      '10-injection',
    ]);
  });

  it('exécute tous les scénarios sur le modèle scripté (mode hors ligne)', async () => {
    // Les évaluations hors ligne ne doivent pas dépendre du `.env` local :
    // on force le mode historique ouvert et on désactive Firestore.
    const previous = {
      AUTH_MODE: process.env.AUTH_MODE,
      ACCESS_CODE: process.env.ACCESS_CODE,
      HISTORY_ENABLED: process.env.HISTORY_ENABLED,
    };
    process.env.AUTH_MODE = 'code';
    delete process.env.ACCESS_CODE;
    process.env.HISTORY_ENABLED = '0';
    try {
      const scenarios = loadScenarios();
      const report: string[] = [];
      for (const scenario of scenarios) {
        const result = await runScenario(scenario, { dryRun: true, logger });
        const failures = result.checks.filter((check) => !check.ok);
        for (const failure of failures) {
          report.push(`${scenario.id} — ${failure.name}: ${failure.detail ?? ''}`);
        }
        if (result.error) report.push(`${scenario.id} — erreur: ${result.error}`);
      }
      expect(report).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});
