/**
 * Format of the evaluation scenarios (evals/scenarios/*.json).
 *
 * A scenario is a list of user turns with deterministic expectations, plus an
 * optional `mock` section that scripts the model (used by the offline run).
 */

export interface MockToolUse {
  name: string;
  input: Record<string, unknown>;
  /** Partial JSON streamed to the client (exercises the canvas_delta path). */
  partial_json?: string;
}

export interface MockTurn {
  text?: string;
  toolUses?: MockToolUse[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
}

export interface Expectation {
  /** A canvas_set is expected (default: no constraint). */
  expect_canvas?: boolean;
  /** Modes of the canvas_set events, in order. */
  canvas_modes?: Array<'create' | 'edit'>;
  /** Maximum number of questions asked in the chat. */
  max_questions?: number;
  /** Minimum number of questions asked in the chat. */
  min_questions?: number;
  /** Expected tool calls: name, number of calls, number of edits, replace flag. */
  tool_calls?: Array<{ name: string; count?: number; count_min?: number; edits?: number; replace?: boolean }>;
  /** Number of edits applied reported by the last canvas_set. */
  edits_applied?: number;
  placeholders_min?: number;
  placeholders_max?: number;
  chat_max_length?: number;
  chat_contains?: string[];
  chat_not_contains?: string[];
  document_contains?: string[];
  document_not_contains?: string[];
  /** Sections that must be identical before and after the turn. */
  unchanged_sections?: string[];
  /** Maximum number of sections allowed to change. */
  max_changed_sections?: number;
  /** Maximum number of blocks (blank-line separated) allowed to change. */
  max_changed_blocks?: number;
  /** No forbidden construct in the Markdown subset (default: true). */
  no_forbidden_construct?: boolean;
  /** No invented fact (name, amount, date) in the document. */
  no_invented_facts?: boolean;
  /** No legal reference may be cited (the notes are empty in V1). */
  no_legal_citation?: boolean;
  /** No legal reference may be cited in the chat either. */
  chat_no_legal_citation?: boolean;
  /** Text manually written by the user that must survive the turn. */
  document_preserved?: string;
}

export interface ScenarioTurn {
  user: string;
  contract_type?: string | null;
  /** Document sent by the client at the beginning of the turn. */
  document?: { markdown: string; version: number } | null;
  expect?: Expectation;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  turns: ScenarioTurn[];
  mock?: MockTurn[];
}

export interface ScenarioFile extends Scenario {
  /** Replaced by the content of evals/fixtures/base-contract.md. */
  $base_contract?: string;
}
