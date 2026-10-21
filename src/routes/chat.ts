/**
 * POST /api/chat — the agentic loop, streamed over SSE.
 *
 * The format of the events is normative: docs/API-CONTRACT.md §3.3.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { SSEStreamingApi } from 'hono/streaming';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { isAbortError, isModelFailure, type LlmClient } from '../llm.js';
import type { Logger } from '../logger.js';
import { runtimeState } from '../runtime-state.js';
import { checkTextSafety, shouldBlock } from '../safety.js';
import type { TemplateStore } from '../templates.js';
import type { AppEnv } from '../types.js';
import { runAgent, type ChatMessage } from '../agent/loop.js';
import type { AgentEmit, AgentEventName, AgentEventPayloads } from '../agent/events.js';

export const MAX_MESSAGES = 30;
export const MAX_MESSAGE_LENGTH = 8000;
export const MAX_DOCUMENT_BYTES = 200_000;
export const PING_INTERVAL_MS = 15_000;

export interface ChatDeps {
  config: AppConfig;
  logger: Logger;
  templates: TemplateStore;
  client: LlmClient;
  /** Test hook: observes the tool calls (used by the evaluations). */
  onToolCall?: (name: string, input: unknown) => void;
}

interface ParsedBody {
  messages: ChatMessage[];
  document: { markdown: string; version: number } | null;
  contractType: string | null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Validates the body of the request, with the error codes of the contract. */
export function parseChatBody(raw: unknown): ParsedBody {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('bad_request', 'Corps de requête invalide.');
  }
  const body = raw as Record<string, unknown>;

  const rawMessages = body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new AppError('bad_request', 'Aucun message fourni.');
  }
  if (rawMessages.length > MAX_MESSAGES) {
    throw new AppError('bad_request', 'Trop de messages : la conversation est tronquée aux 30 derniers messages.');
  }

  const messages: ChatMessage[] = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== 'object') {
      throw new AppError('bad_request', 'Message invalide.');
    }
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new AppError('bad_request', 'Rôle de message invalide.');
    }
    if (typeof message.content !== 'string') {
      throw new AppError('bad_request', 'Contenu de message invalide.');
    }
    if (message.content.length > MAX_MESSAGE_LENGTH) {
      throw new AppError('payload_too_large', 'Un message est trop long.');
    }
    messages.push({ role: message.role, content: message.content });
  }

  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]!.role === messages[index - 1]!.role) {
      throw new AppError('bad_request', 'Les rôles des messages doivent alterner.');
    }
  }
  if (messages[messages.length - 1]!.role !== 'user') {
    throw new AppError('bad_request', 'Le dernier message doit venir de l’utilisateur.');
  }

  let document: { markdown: string; version: number } | null = null;
  const rawDocument = body.document;
  if (rawDocument !== null && rawDocument !== undefined) {
    if (typeof rawDocument !== 'object') {
      throw new AppError('bad_request', 'Document invalide.');
    }
    const candidate = rawDocument as Record<string, unknown>;
    if (typeof candidate.markdown !== 'string') {
      throw new AppError('bad_request', 'Document invalide : le texte est absent.');
    }
    if (byteLength(candidate.markdown) > MAX_DOCUMENT_BYTES) {
      throw new AppError('payload_too_large', 'Le document est trop long.');
    }
    const version = candidate.version;
    if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
      throw new AppError('bad_request', 'Document invalide : version incorrecte.');
    }
    document = { markdown: candidate.markdown, version: typeof version === 'number' ? version : 1 };
  }

  const rawContractType = body.contract_type;
  if (rawContractType !== null && rawContractType !== undefined && typeof rawContractType !== 'string') {
    throw new AppError('bad_request', 'Type de contrat invalide.');
  }
  const contractType = typeof rawContractType === 'string' && rawContractType.length > 0 ? rawContractType : null;

  return { messages, document, contractType };
}

/** Opens an SSE response with the headers required by the contract. */
function sseResponse(c: Context, callback: (stream: SSEStreamingApi) => Promise<void>): Response {
  const { readable, writable } = new TransformStream();
  const stream = new SSEStreamingApi(writable, readable);

  c.header('Content-Type', 'text/event-stream; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');
  c.header('Connection', 'keep-alive');

  void (async () => {
    try {
      await callback(stream);
    } catch (error) {
      console.error('sse_stream_error', error);
    } finally {
      await stream.close();
    }
  })();

  return c.newResponse(stream.responseReadable);
}

export function chatRoutes(deps: ChatDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { config, logger, templates, client } = deps;

  app.post('/api/chat', async (c) => {
    if (runtimeState.shuttingDown) {
      throw new AppError('llm_unavailable', 'Le service s’arrête, réessayez dans un instant.');
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Corps de requête invalide.');
    }

    const parsed = parseChatBody(raw);
    const requestId = c.get('requestId') ?? '-';
    const logger = deps.logger.child({ request_id: requestId });

    // Garde-fou : le message de l'utilisateur passe par le modèle de sécurité
    // avant l'ouverture du flux. Un garde-fou indisponible laisse passer.
    if (config.safetyCheck) {
      const lastUserMessage = parsed.messages[parsed.messages.length - 1]!.content;
      const verdict = await checkTextSafety({
        client,
        model: config.safetyModel,
        text: lastUserMessage,
        signal: c.req.raw.signal ?? new AbortController().signal,
        logger,
      });
      if (!verdict.safe) {
        if (shouldBlock(verdict, config.safetyMode, verdict.inDomain)) {
          logger.warn('safety_blocked_request', { label: verdict.label, in_domain: verdict.inDomain });
          throw new AppError(
            'bad_request',
            'Votre demande a été bloquée par le filtre de sécurité. Reformulez votre demande.',
          );
        }
        logger.warn('safety_flagged_request', { label: verdict.label, in_domain: verdict.inDomain });
      }
    }

    return sseResponse(c, async (stream) => {
      const abortController = new AbortController();
      let clientGone = false;
      let timedOut = false;
      let writeChain: Promise<void> = Promise.resolve();

      const write = (payload: string): void => {
        writeChain = writeChain.then(async () => {
          if (clientGone) return;
          try {
            await stream.write(payload);
          } catch {
            clientGone = true;
            abortController.abort();
          }
        });
      };

      const emit: AgentEmit = <K extends AgentEventName>(event: K, data: AgentEventPayloads[K]) => {
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      stream.onAbort(() => {
        clientGone = true;
        abortController.abort();
      });

      c.req.raw.signal?.addEventListener('abort', () => {
        clientGone = true;
        abortController.abort();
      }, { once: true });

      const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, config.requestTimeoutMs);

      const ping = setInterval(() => {
        write(': ping\n\n');
      }, PING_INTERVAL_MS);

      emit('ready', { request_id: requestId });

      const startedAt = Date.now();
      let outcome: 'end_turn' | 'max_steps' | 'error' = 'error';
      let usage = { input_tokens: 0, output_tokens: 0 };
      let steps = 0;
      let modelsUsed: string[] = [];

      try {
        const result = await runAgent({
          client,
          config,
          logger,
          templates,
          messages: parsed.messages,
          document: parsed.document,
          contractType: parsed.contractType,
          emit,
          signal: abortController.signal,
          onToolCall: deps.onToolCall,
        });
        outcome = result.stopReason;
        usage = result.usage;
        steps = result.steps;
        modelsUsed = result.modelsUsed;

        if (timedOut) {
          emit('error', {
            code: 'timeout',
            message: 'La génération a pris trop de temps. Réessayez.',
            retryable: true,
          });
          outcome = 'error';
        }
      } catch (error) {
        if (clientGone) {
          logger.info('client_disconnected', { duration_ms: Date.now() - startedAt });
        } else if (timedOut) {
          emit('error', {
            code: 'timeout',
            message: 'La génération a pris trop de temps. Réessayez.',
            retryable: true,
          });
        } else if (isAbortError(error)) {
          logger.info('request_aborted', { duration_ms: Date.now() - startedAt });
        } else {
          const providerError = isModelFailure(error);
          logger.error('agent_failed', {
            duration_ms: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          emit('error', {
            code: providerError ? 'llm_unavailable' : 'llm_error',
            message: providerError
              ? 'Le service de rédaction est momentanément indisponible. Réessayez.'
              : 'Le service de rédaction est momentanément indisponible. Réessayez.',
            retryable: true,
          });
        }
      } finally {
        clearTimeout(timeout);
        clearInterval(ping);
      }

      await writeChain;
      logger.info('chat_done', {
        request_id: requestId,
        duration_ms: Date.now() - startedAt,
        outcome,
        steps,
        models: modelsUsed.join(','),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      });
    });
  });

  return app;
}
