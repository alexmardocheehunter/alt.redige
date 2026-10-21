/**
 * Events of the `/api/chat` stream, as defined by docs/API-CONTRACT.md §3.3.
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

export interface AgentEventPayloads {
  ready: { request_id: string };
  text_delta: { text: string };
  status: { phase: AgentPhase; label: string };
  canvas_start: { mode: 'create' | 'edit'; title?: string; contract_type?: string };
  canvas_delta: { text: string };
  canvas_set: CanvasSetPayload;
  error: { code: ErrorCode; message: string; retryable: boolean };
  done: {
    stop_reason: 'end_turn' | 'max_steps';
    usage: { input_tokens: number; output_tokens: number };
  };
}

export type AgentEventName = keyof AgentEventPayloads;

export type AgentEmit = <K extends AgentEventName>(event: K, data: AgentEventPayloads[K]) => void;
