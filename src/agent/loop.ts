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
import type { AgentEmit, AgentEventPayloads } from './events.js';
import { extractPartialString, readPartialString } from './json-partial.js';
import { buildSystemPrompt, buildUserContext, buildModelBlock } from './prompt.js';
import { ChatGuard } from './chat-guard.js';
import { buildSuggestions, Progress } from './progress.js';
import { sourcesForTemplate } from '../legal-sources.js';
import { findEnglishWords } from '../doc/lexical.js';
import {
  executeTool,
  toolDefinitions,
  TOOL_ASK_USER,
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
  /** Identifiant de la requête, repris dans l'événement `done`. */
  requestId?: string;
  /** Instant de départ du flux, pour la durée dans l'événement `done`. */
  startedAt?: number;
  /** Test hook: observes the tool calls (used by the evaluations). */
  onToolCall?: (name: string, input: unknown) => void;
}

export interface RunAgentResult {
  stopReason: 'end_turn' | 'max_steps' | 'awaiting_input';
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

/** Nombre d'espaces réservés annoncés par un outil (0 si l'outil n'en dit rien). */
function readPlaceholders(content: string): number {
  try {
    const parsed = JSON.parse(content) as { placeholders?: number };
    return typeof parsed.placeholders === 'number' ? parsed.placeholders : 0;
  } catch {
    return 0;
  }
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

  // Le modèle de référence est épinglé dans le contexte : pas d'aller-retour
  // pour `get_template` quand le type est connu, et des notes juridiques
  // présentes à chaque tour (la troncature de l'historique ne peut pas les
  // faire disparaître).
  const template = contractType ? templates.get(contractType) ?? null : null;
  const modelBlock = buildModelBlock(template, { withSkeleton: document === null });

  conversation.push({
    role: 'user',
    content: buildUserContext({
      document: document ? { markdown: document.markdown, version: document.version } : null,
      contractType,
      userText: lastMessage.content,
      modelBlock,
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
    documentVersion: baseVersion + setsEmitted,
    maxEditChangedBlocks: config.maxEditChangedBlocks,
    askUserCounter: 0,
    signal,
  };

  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  const modelsUsed: string[] = [];
  let step = 0;
  let askedUser = false;
  let lastPlaceholders = 0;
  const chatGuard = new ChatGuard();
  let contractWarned = false;

  // Progression visible (AGENT-PROTOCOL.md §3, §4, §6, §7, §9).
  const progress = new Progress(emit, document !== null);
  progress.phase('understanding');
  progress.plan();
  progress.step('s1', 'running');

  /** Payload de l'événement `done` (AGENT-PROTOCOL.md §12). */
  const done = (stop_reason: 'end_turn' | 'awaiting_input' | 'max_steps'): AgentEventPayloads['done'] => ({
    stop_reason,
    usage: totalUsage,
    ...(params.requestId ? { request_id: params.requestId } : {}),
    ...(params.startedAt ? { duration_ms: Date.now() - params.startedAt } : {}),
  });

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
      onRetry: (info) => {
        emit('retry', {
          attempt: info.attempt,
          max: info.max,
          label: info.label,
          delay_ms: info.delay_ms,
        });
      },
      onText: (delta) => {
        // Le contrat ne doit pas être écrit dans le chat : le texte est
        // examiné avant d'être relayé.
        const relayed = chatGuard.filter(delta);
        if (relayed === null) {
          if (chatGuard.tripped && !contractWarned) {
            contractWarned = true;
            emit('warning', {
              code: 'contract_in_chat',
              label: 'Le contrat a été écrit dans le document, pas dans le chat.',
            });
          }
          return;
        }
        emit('text_delta', { text: relayed });
      },
      onToolStart: (toolCallId, name) => {
        if (name === TOOL_CREATE_CANVAS) {
          canvasStates.set(toolCallId, createCanvasState());
          emit('status', { phase: 'drafting', label: 'Rédaction du contrat…' });
          progress.phase('drafting');
          progress.step('s1', 'done');
          progress.step('s2', 'done');
          progress.step(document === null ? 's3' : 's2', 'running');
        } else if (name === TOOL_EDIT_CANVAS) {
          emit('status', { phase: 'editing', label: 'Modification du contrat…' });
          progress.phase('drafting');
          progress.step('s1', 'done');
          progress.step('s2', 'running');
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
      progress.phase('finalizing');
      progress.step(document === null ? 's4' : 's3', 'done');
      progress.suggestions(buildSuggestions({
        hasDocument: document !== null || setsEmitted > 0,
        placeholders: lastPlaceholders,
        askedUser: false,
      }));
      emit('done', done('end_turn'));
      return { stopReason: 'end_turn', usage: totalUsage, steps: step, modelsUsed };
    }

    // Echo the assistant message (with its tool calls) then the tool results.
    conversation.push(outcome.content);

    const toolResults: LlmMessage[] = [];

    for (const toolUse of outcome.toolUses) {
      if (signal.aborted) break;
      params.onToolCall?.(toolUse.name, toolUse.input);

      // §15 : `ask_user` est toujours immédiatement suivi de `done`.
      // La question n'est donc pas encadrée par `tool_start`/`tool_end`.
      const isQuestion = toolUse.name === TOOL_ASK_USER;
      const toolId = isQuestion ? null : progress.toolStart(toolUse.name);
      const result = await executeTool(toolUse.name, toolUse.input, toolContext);
      if (toolId) progress.toolEnd(toolId, toolUse.name, !result.isError, result.summary);
      // Le contrat d'API (API-CONTRACT.md §3.3) définit `version` comme
      // « document.version reçu + nombre de canvas_set déjà émis + 1 ».
      // Seuls les appels d'outil qui ont réellement écrit dans le Canvas
      // comptent : un `get_template` réussi ne change pas la version.
      if (result.emittedCanvasSet) {
        setsEmitted += 1;
        progress.phase('reviewing');
        progress.step(document === null ? 's3' : 's2', 'done');
        progress.step(document === null ? 's4' : 's3', 'running');
        lastPlaceholders = readPlaceholders(result.content);
        progress.sources(sourcesForTemplate(
          templates.get(toolContext.workingDocType ?? contractType ?? '') ?? null,
        ));
      }
      toolResults.push({
        role: 'tool',
        toolCallId: toolUse.id,
        content: result.content,
      });

      // L'agent a posé une question : le tour s'arrête sur `awaiting_input`
      // (AGENT-PROTOCOL.md §8). La réponse arrive au tour suivant.
      if (result.askedUser) {
        askedUser = true;
        break;
      }
    }

    if (signal.aborted) break;

    if (askedUser) {
      // §8 : `ask_user` est toujours immédiatement suivi de `done(awaiting_input)`.
      // Le tour s'arrête ici : la réponse arrive au tour suivant.
      emit('done', done('awaiting_input'));
      return { stopReason: 'awaiting_input', usage: totalUsage, steps: step, modelsUsed };
    }

    conversation.push(...toolResults);

    // Le document a changé : le modèle doit le revoir, sinon il continue sur
    // l'état précédent et réédite la même clause (constaté en campagne réelle :
    // quatre `edit_canvas` successifs et une fin de tour en `max_steps`).
    if (toolContext.workingDoc && canvasEventEmitted) {
      conversation.push({
        role: 'user',
        content:
          '<document_courant version="'
          + String(baseVersion + setsEmitted)
          + '">\n'
          + toolContext.workingDoc
          + '\n</document_courant>\n\n'
          + 'Le document ci-dessus vient d’être mis à jour par ton outil. '
          + 'C’est l’état actuel : ne le modifie pas à nouveau pour la même demande. '
          + 'Si le document est conforme à la demande de l’utilisateur, réponds en une phrase.',
      });
    }
  }

  if (signal.aborted) {
    return { stopReason: 'max_steps', usage: totalUsage, steps: step, modelsUsed };
  }

  emit('done', done('max_steps'));
  return { stopReason: 'max_steps', usage: totalUsage, steps: step, modelsUsed };
}
