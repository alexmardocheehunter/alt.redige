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
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { streamCompletion, type LlmClient, type LlmMessage, type LlmOutcome } from '../llm.js';
import type { Logger } from '../logger.js';
import type { TemplateStore } from '../templates.js';
import type { AgentEmit } from './events.js';
import { extractPartialString, readPartialString } from './json-partial.js';
import { buildSystemPrompt, buildUserContext } from './prompt.js';
import { findEnglishWords } from '../doc/lexical.js';
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
  client: LlmClient;
  config: AppConfig;
  logger: Logger;
  templates: TemplateStore;
  messages: ChatMessage[];
  document: AgentDocument | null;
  contractType: string | null;
  emit: AgentEmit;
  signal: AbortSignal;
  /** Test hook: observes the tool calls (used by the evaluations). */
  onToolCall?: (name: string, input: unknown) => void;
}

export interface RunAgentResult {
  stopReason: 'end_turn' | 'max_steps';
  usage: { input_tokens: number; output_tokens: number };
  steps: number;
  /** Models that served the request, in the order they were tried. */
  modelsUsed: string[];
}

/**
 * Sélectionne l'historique renvoyé au modèle.
 *
 * L'historique complet et le document courant sont retransmis à chaque étape
 * de la boucle : le volume transmis au fournisseur croît donc avec la
 * longueur de la conversation. On conserve toujours le **premier** message de
 * l'utilisateur (la demande initiale) et les derniers messages (le contexte
 * immédiat), et on retire le milieu.
 */
export function selectHistory(messages: ChatMessage[], max: number): ChatMessage[] {
  if (messages.length <= max) return [...messages];

  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  const first = firstUserIndex === -1 ? messages[0]! : messages[firstUserIndex]!;
  const tail = messages.slice(-(max - 1));

  if (first === tail[0]) return tail;
  return [first, ...tail];
}

/** Tracks the streaming of the `create_canvas` arguments. */
interface CanvasStreamState {
  started: boolean;
  emittedMarkdown: string;
  pendingDeltas: string[];
  title?: string;
  contractType?: string;
}

function createCanvasState(): CanvasStreamState {
  return {
    started: false,
    emittedMarkdown: '',
    pendingDeltas: [],
  };
}

export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const { client, config, logger, templates, messages, document, contractType, emit, signal } = params;

  const system = buildSystemPrompt(templates);
  const tools = toolDefinitions(templates);

  const conversation: LlmMessage[] = [];

  for (const message of selectHistory(messages, config.maxHistoryMessages).slice(0, -1)) {
    conversation.push({ role: message.role, content: message.content });
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    throw new AppError('bad_request', 'Aucun message à traiter.');
  }

  conversation.push({
    role: 'user',
    content: buildUserContext({
      document: document ? { markdown: document.markdown, version: document.version } : null,
      contractType,
      userText: lastMessage.content,
    }),
  });

  // Mutable state of the loop.
  const baseVersion = document?.version ?? 0;
  let setsEmitted = 0;
  let canvasEventEmitted = false;

  // Ce que l'utilisateur a réellement dit : sert au garde-fou P0-3 (refuser
  // de rédiger un contrat sans information exploitable).
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');

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
    client,
    safetyModel: config.safetyModel,
    safetyEnabled: config.safetyCheck,
    safetyMode: config.safetyMode,
    userText,
    maxEditChangedBlocks: config.maxEditChangedBlocks,
    signal,
  };

  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  const modelsUsed: string[] = [];
  let step = 0;

  for (step = 1; step <= config.maxSteps; step += 1) {
    if (signal.aborted) break;

    const canvasStates = new Map<string, CanvasStreamState>();
    const partials = new Map<string, string>();

    const outcome: LlmOutcome = await streamCompletion(client, {
      models: config.models,
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
      onToolStart: (toolCallId, name) => {
        if (name === TOOL_CREATE_CANVAS) {
          canvasStates.set(toolCallId, createCanvasState());
          emit('status', { phase: 'drafting', label: 'Rédaction du contrat…' });
        } else if (name === TOOL_EDIT_CANVAS) {
          emit('status', { phase: 'editing', label: 'Modification du contrat…' });
        }
      },
      onToolInputDelta: (toolCallId, chunk) => {
        const state = canvasStates.get(toolCallId);
        if (!state) return;

        const partial = (partials.get(toolCallId) ?? '') + chunk;
        partials.set(toolCallId, partial);

        const markdown = extractPartialString(partial, 'markdown');
        const title = readPartialString(partial, 'title');
        const type = readPartialString(partial, 'contract_type');

        // The title and the type are only used once their value is complete.
        if (title?.complete) state.title = title.value;
        if (type?.complete) state.contractType = type.value;

        // `canvas_start` is emitted as soon as the title and the type are readable.
        if (!state.started && state.title && state.contractType) {
          state.started = true;
          emit('canvas_start', {
            mode: 'create',
            title: state.title,
            contract_type: state.contractType,
          });
          for (const pending of state.pendingDeltas) {
            emit('canvas_delta', { text: pending });
          }
          state.pendingDeltas = [];
        }

        if (markdown === undefined) return;

        // Only the new suffix is sent, and only if the value grows.
        if (!markdown.startsWith(state.emittedMarkdown)) return;
        const suffix = markdown.slice(state.emittedMarkdown.length);
        if (!suffix) return;
        state.emittedMarkdown = markdown;

        if (state.started) {
          emit('canvas_delta', { text: suffix });
        } else {
          state.pendingDeltas.push(suffix);
        }
      },
    });

    modelsUsed.push(outcome.model);
    totalUsage.input_tokens += outcome.usage.inputTokens;
    totalUsage.output_tokens += outcome.usage.outputTokens;

    // The model stopped on the token limit: the contract is cut, nothing is applied.
    if (outcome.stopReason === 'max_tokens') {
      logger.warn('agent_truncated', { step, model: outcome.model, tool_calls: outcome.toolUses.length });
      emit('error', {
        code: 'truncated',
        message:
          'Le contrat est trop long pour être généré d’un seul coup. Réessayez ou demandez-le en plusieurs parties.',
        retryable: true,
      });
      return { stopReason: 'max_steps', usage: totalUsage, steps: step, modelsUsed };
    }

    if (outcome.toolUses.length === 0) {
      // Le message destiné à l'utilisateur doit être en français (P1-4).
      const anglicisms = findEnglishWords(outcome.text);
      if (anglicisms.length > 0) {
        logger.warn('chat_anglicism', { words: anglicisms.length });
      }
      emit('done', { stop_reason: 'end_turn', usage: totalUsage });
      return { stopReason: 'end_turn', usage: totalUsage, steps: step, modelsUsed };
    }

    // Echo the assistant message (with its tool calls) then the tool results.
    conversation.push(outcome.content);

    const toolResults: LlmMessage[] = [];

    for (const toolUse of outcome.toolUses) {
      if (signal.aborted) break;
      params.onToolCall?.(toolUse.name, toolUse.input);
      const result = await executeTool(toolUse.name, toolUse.input, toolContext);
      // Le contrat d'API (API-CONTRACT.md §3.3) définit `version` comme
      // « document.version reçu + nombre de canvas_set déjà émis + 1 ».
      // Seuls les appels d'outil qui ont réellement écrit dans le Canvas
      // comptent : un `get_template` réussi ne change pas la version.
      if (result.emittedCanvasSet) setsEmitted += 1;
      toolResults.push({
        role: 'tool',
        toolCallId: toolUse.id,
        content: result.content,
      });
    }

    if (signal.aborted) break;

    conversation.push(...toolResults);
  }

  if (signal.aborted) {
    return { stopReason: 'max_steps', usage: totalUsage, steps: step, modelsUsed };
  }

  emit('done', { stop_reason: 'max_steps', usage: totalUsage });
  return { stopReason: 'max_steps', usage: totalUsage, steps: step, modelsUsed };
}
