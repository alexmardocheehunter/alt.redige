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
    const scenarios = loadScenarios();
    for (const scenario of scenarios) {
      const result = await runScenario(scenario, { dryRun: true, logger });
      const failures = result.checks.filter((check) => !check.ok);
      expect(failures.map((check) => `${check.name}: ${check.detail ?? ''}`)).toEqual([]);
      expect(result.ok).toBe(true);
    }
  }, 60_000);
});
