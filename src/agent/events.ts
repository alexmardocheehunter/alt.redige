/**
 * Events of the `/api/chat` stream, as defined by docs/API-CONTRACT.md §3.3,
 * extended by docs/AGENT-PROTOCOL.md (additive: no existing event changes).
 */
import type { ErrorCode } from '../errors.js';
import type { Issue } from '../doc/validate.js';

export type AgentPhase = 'template' | 'drafting' | 'editing';

export interface CanvasSetPayload {
  mode: 'create' | 'edit';
  markdown: string;
  version: number;
  title?: string;
  contract_type?: string;
  edits_applied?: number;
  validation: {
    placeholders: number;
    issues: Issue[];
  };
}

/* ------------------------------------------------------------------ */
/* AGENT-PROTOCOL.md                                                    */
/* ------------------------------------------------------------------ */

/** Phase de progression, telle que décrite par l'utilisateur. */
export type ProgressPhase =
  | 'understanding'
  | 'researching'
  | 'planning'
  | 'drafting'
  | 'reviewing'
  | 'finalizing';

export type StepState = 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  label: string;
}

export interface StepPayload {
  id: string;
  state: StepState;
  detail?: string;
  label?: string;
}

export type QuestionKind = 'single' | 'multi' | 'text' | 'confirm' | 'form';

export interface QuestionOption {
  id: string;
  label: string;
  hint?: string;
}

export interface QuestionField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'amount' | 'date' | 'select';
  required: boolean;
  placeholder?: string;
  unit?: string;
  options?: QuestionOption[];
}

export interface AskUserPayload {
  question_id: string;
  kind: QuestionKind;
  question: string;
  why?: string;
  blocking: boolean;
  allow_other: boolean;
  default?: string;
  options?: QuestionOption[];
  placeholder?: string;
  max_length?: number;
  fields?: QuestionField[];
}

export interface SourceItem {
  id: string;
  title: string;
  ref?: string;
  kind: 'law' | 'template' | 'user';
  url?: string | null;
}

export interface SuggestionItem {
  label: string;
  message: string;
}

/**
 * `done` enrichi (AGENT-PROTOCOL.md §12).
 *
 * `max_steps` vient du contrat d'API v1.0 ; `awaiting_input`, `cancelled`
 * et `max_tokens` sont ajoutés par le protocole agent. Le protocole parle de
 * `max_tokens` là où le contrat parle de `max_steps` : la valeur existante
 * est conservée pour ne pas casser le frontend livré contre le contrat.
 */
export type StopReason =
  | 'end_turn'
  | 'awaiting_input'
  | 'cancelled'
  | 'max_tokens'
  | 'max_steps';

export interface AgentEventPayloads {
  ready: { request_id: string };
  text_delta: { text: string };
  status: { phase: AgentPhase; label: string };
  canvas_start: {
    mode: 'create' | 'edit';
    title?: string;
    contract_type?: string;
    target?: { block_index?: number; article?: number };
    reason?: string;
  };
  canvas_delta: { text: string };
  canvas_set: CanvasSetPayload;
  error: { code: ErrorCode; message: string; retryable: boolean };
  done: {
    stop_reason: StopReason;
    usage?: { input_tokens: number; output_tokens: number };
    request_id?: string;
    duration_ms?: number;
  };

  /* -- AGENT-PROTOCOL.md -- */
  phase: { phase: ProgressPhase; label: string };
  plan: { steps: PlanStep[] };
  step: StepPayload;
  ask_user: AskUserPayload;
  sources: { items: SourceItem[] };
  suggestions: { items: SuggestionItem[] };
  retry: { attempt: number; max: number; label: string; delay_ms: number };
  warning: { code: string; label: string };
  tool_start: { id: string; name: string; label: string };
  tool_end: { id: string; name: string; ok: boolean; duration_ms?: number; result_summary?: string };
}

export type AgentEventName = keyof AgentEventPayloads;

export type AgentEmit = <K extends AgentEventName>(event: K, data: AgentEventPayloads[K]) => void;
