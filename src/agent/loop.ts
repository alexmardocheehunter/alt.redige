/**
 * The agentic loop.
 *
 * Flow (SPEC-BACKEND.md §4):
 *   for step of 1 to MAX_STEPS:
 *     open a model stream, relay the text deltas,
 *     stream the `create_canvas` arguments into the Canvas,
 *     execute the requested tools, send the results back to the model.
 *
 * The loop is stateless: the client sends the history and the current document.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { streamCompletion, type LlmOutcome } from '../llm.js';
import type { Logger } from '../logger.js';
import type { TemplateStore } from '../templates.js';
import type { AgentEmit } from './events.js';
import { extractPartialString, readPartialString } from './json-partial.js';
import { buildSystemPrompt, buildUserContextBlocks } from './prompt.js';
import {
  executeTool,
  toolDefinitions,
  TOOL_CREATE_CANVAS,
  TOOL_EDIT_CANVAS,
  type ToolContext,
} from './tools.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentDocument {
  markdown: string;
  version: number;
}

export interface RunAgentParams {
  client: Anthropic;
  config: AppConfig;
  logger: Logger;
  templates: TemplateStore;
  messages: ChatMessage[];
  document: AgentDocument | null;
  contractType: string | null;
  emit: AgentEmit;
  signal: AbortSignal;
}

export interface RunAgentResult {
  stopReason: 'end_turn' | 'max_steps';
  usage: { input_tokens: number; output_tokens: number };
  steps: number;
}

/** Tracks the streaming of the `create_canvas` arguments. */
interface CanvasStreamState {
  active: boolean;
  started: boolean;
  emittedMarkdown: string;
  pendingDeltas: string[];
  title?: string;
  contractType?: string;
}

function createCanvasState(): CanvasStreamState {
  return {
    active: false,
    started: false,
    emittedMarkdown: '',
    pendingDeltas: [],
  };
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { client, config, logger, templates, messages, document, contractType, emit, signal } = params;

  const system = buildSystemPrompt(templates);
  const tools = toolDefinitions(templates);

  const conversation: MessageParam[] = [];

  for (const message of messages.slice(0, -1)) {
    conversation.push({ role: message.role, content: message.content });
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    throw new AppError('bad_request', 'Aucun message à traiter.');
  }

  const userBlocks = buildUserContextBlocks({
    document: document ? { markdown: document.markdown, version: document.version } : null,
    contractType,
    userText: lastMessage.content,
  }).map((text) => ({ type: 'text' as const, text }));

  conversation.push({ role: 'user', content: userBlocks });

  // Mutable state of the loop.
  const baseVersion = document?.version ?? 0;
  let setsEmitted = 0;
  let canvasEventEmitted = false;

  const toolContext: ToolContext = {
    workingDoc: document?.markdown ?? null,
    workingDocType: contractType,
    templates,
    emit: (event, data) => {
      if (event === 'canvas_start' || event === 'canvas_delta' || event === 'canvas_set') {
        canvasEventEmitted = true;
      }
      emit(event, data);
    },
    nextVersion: () => baseVersion + setsEmitted + 1,
    logger,
  };

  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  let step = 0;

  for (step = 1; step <= config.maxSteps; step += 1) {
    if (signal.aborted) break;

    const canvasState = createCanvasState();
    let partialJson = '';
    let currentToolId: string | null = null;

    const outcome: LlmOutcome = await streamCompletion(client, {
      model: config.model,
      system,
      messages: conversation,
      tools,
      maxTokens: config.maxOutputTokens,
      signal,
      logger,
      canRetry: () => !canvasEventEmitted,
      onText: (delta) => {
        emit('text_delta', { text: delta });
      },
      onToolStart: (toolUseId, name) => {
        currentToolId = toolUseId;
        partialJson = '';
        if (name === TOOL_CREATE_CANVAS) {
          canvasState.active = true;
          emit('status', { phase: 'drafting', label: 'Rédaction du contrat…' });
        } else if (name === TOOL_EDIT_CANVAS) {
          emit('status', { phase: 'editing', label: 'Modification du contrat…' });
        }
      },
      onToolInputDelta: (chunk) => {
        if (currentToolId === null) return;
        partialJson += chunk;
        if (!canvasState.active) return;

        const markdown = extractPartialString(partialJson, 'markdown');
        const title = readPartialString(partialJson, 'title');
        const type = readPartialString(partialJson, 'contract_type');

        // The title and the type are only used once their value is complete.
        if (title?.complete) canvasState.title = title.value;
        if (type?.complete) canvasState.contractType = type.value;

        // `canvas_start` is emitted as soon as the title and the type are readable.
        if (!canvasState.started && canvasState.title && canvasState.contractType) {
          canvasState.started = true;
          emit('canvas_start', {
            mode: 'create',
            title: canvasState.title,
            contract_type: canvasState.contractType,
          });
          for (const pending of canvasState.pendingDeltas) {
            emit('canvas_delta', { text: pending });
          }
          canvasState.pendingDeltas = [];
        }

        if (markdown === undefined) return;

        // Only the new suffix is sent, and only if the value grows.
        if (!markdown.startsWith(canvasState.emittedMarkdown)) return;
        const suffix = markdown.slice(canvasState.emittedMarkdown.length);
        if (!suffix) return;
        canvasState.emittedMarkdown = markdown;

        if (canvasState.started) {
          emit('canvas_delta', { text: suffix });
        } else {
          canvasState.pendingDeltas.push(suffix);
        }
      },
    });

    totalUsage.input_tokens += outcome.usage.inputTokens;
    totalUsage.output_tokens += outcome.usage.outputTokens;

    // The model stopped on the token limit: the contract is cut, nothing is applied.
    if (outcome.stopReason === 'max_tokens') {
      logger.warn('agent_truncated', { step, tool_calls: outcome.toolUses.length });
      emit('error', {
        code: 'truncated',
        message:
          'Le contrat est trop long pour être généré d’un seul coup. Réessayez ou demandez-le en plusieurs parties.',
        retryable: true,
      });
      return { stopReason: 'max_steps', usage: totalUsage, steps: step };
    }

    if (outcome.toolUses.length === 0) {
      emit('done', { stop_reason: 'end_turn', usage: totalUsage });
      return { stopReason: 'end_turn', usage: totalUsage, steps: step };
    }

    // Echo the assistant message (with its tool calls) then the tool results.
    conversation.push({ role: 'assistant', content: outcome.content });

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }> = [];

    for (const toolUse of outcome.toolUses) {
      if (signal.aborted) break;
      const result = executeTool(toolUse.name, toolUse.input, toolContext);
      if (!result.isError) setsEmitted += 1;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    if (signal.aborted) break;

    conversation.push({ role: 'user', content: toolResults });
  }

  if (signal.aborted) {
    return { stopReason: 'max_steps', usage: totalUsage, steps: step };
  }

  emit('done', { stop_reason: 'max_steps', usage: totalUsage });
  return { stopReason: 'max_steps', usage: totalUsage, steps: step };
}
