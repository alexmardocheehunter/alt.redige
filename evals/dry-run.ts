/**
 * Offline model used by the evaluations (`--dry-run`).
 *
 * It replays the `mock` section of the scenario: the harness (SSE decoding,
 * tool execution, assertions) is exercised without calling the real provider.
 */
import { FakeAnthropic, type FakeTurn } from '../test/fake-llm.js';
import type { Scenario } from './types.js';

export function createDryRunClient(scenario: Scenario): FakeAnthropic {
  const turns: FakeTurn[] = (scenario.mock ?? []).map((turn, turnIndex) => ({
    text: turn.text,
    stopReason: turn.stopReason,
    toolUses: (turn.toolUses ?? []).map((tool, toolIndex) => ({
      id: `tool_dry_${turnIndex}_${toolIndex}`,
      name: tool.name,
      input: tool.input,
      partialJson: tool.partial_json,
    })),
  }));

  return new FakeAnthropic(turns);
}
