/**
 * Offline model used by the evaluations (`--dry-run`).
 *
 * It replays the `mock` section of the scenario: the harness (SSE decoding,
 * tool execution, assertions) is exercised without calling the real provider.
 */
import { FakeOpenRouter, fakeClient, type FakeTurn } from '../test/fake-llm.js';
import type { LlmClient } from '../src/llm.js';
import type { Scenario } from './types.js';

export function createDryRunClient(scenario: Scenario): LlmClient {
  const turns: FakeTurn[] = (scenario.mock ?? []).map((turn, turnIndex) => ({
    text: turn.text,
    finishReason: turn.stopReason === 'max_tokens'
      ? 'length'
      : turn.stopReason === 'tool_use'
        ? 'tool_calls'
        : turn.stopReason === 'end_turn'
          ? 'stop'
          : undefined,
    toolUses: (turn.toolUses ?? []).map((tool, toolIndex) => ({
      id: `tool_dry_${turnIndex}_${toolIndex}`,
      name: tool.name,
      input: tool.input,
      partialJson: tool.partial_json,
    })),
  }));

  return fakeClient(new FakeOpenRouter({ turns }));
}
