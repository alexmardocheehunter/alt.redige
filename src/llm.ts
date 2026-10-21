/**
 * Client OpenRouter — le seul fichier qui connaît le fournisseur de modèle.
 *
 * OpenRouter expose une API compatible OpenAI : `POST /chat/completions`,
 * flux SSE, appels de fonction. On parle à l'API en `fetch` natif : aucune
 * dépendance supplémentaire n'est introduite.
 *
 * Trois modèles sont utilisés en bascule : le principal d'abord, puis les
 * suivants tant qu'aucun événement Canvas n'a été émis (une fois le contrat
 * commencé, on ne recommence pas : le client ne doit jamais voir de
 * demi-document).
 */
import type { Logger } from './logger.js';

/* ------------------------------------------------------------------ */
/* Types neutres (independants du fournisseur)                          */
/* ------------------------------------------------------------------ */

export interface LlmToolCall {
  id: string;
  name: string;
  /** Arguments JSON, sous forme de chaîne. */
  arguments: string;
}

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Appels d'outils demandés par le modèle (message assistant). */
  toolCalls?: LlmToolCall[];
  /** Rappel de l'appel d'outils (message `tool`). */
  toolCallId?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** Schéma JSON des arguments. */
  parameters: Record<string, unknown>;
}

export type LlmStopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmOutcome {
  stopReason: LlmStopReason;
  usage: LlmUsage;
  toolUses: LlmToolUse[];
  text: string;
  /** Message assistant à renvoyer au modèle (avec ses appels d'outils). */
  content: LlmMessage;
  /** Modèle qui a effectivement servi la réponse. */
  model: string;
}

export interface LlmClient {
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

export class LlmError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Erreur HTTP renvoyée par le fournisseur. */
export class LlmHttpError extends LlmError {
  constructor(readonly status: number, message: string, readonly body?: string) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/**
 * Message lisible d'une erreur réseau : `fetch failed` seul ne dit rien,
 * la cause (délai de connexion, TLS, DNS…) est dans `cause`.
 */
export function describeNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Erreur réseau vers le fournisseur de modèle.';
  const cause = (error as { cause?: unknown })?.cause;

  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    const detail = cause.message;
    return code ? `${message} (${code} : ${detail})` : `${message} (${detail})`;
  }
  return message;
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export interface OpenRouterClientOptions {
  baseUrl: string;
  apiKey: string;
  siteUrl?: string | null;
  appTitle?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Erreur de socket : la connexion a été fermée par l'autre partie (pool
 * `keep-alive` réutilisant une connexion morte,.proxy qui coupe, etc.).
 * Ce n'est pas une erreur du modèle : on peut réessayer sur une nouvelle
 * connexion.
 */
export function isRetryableSocketError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? '';
  const message = `${cause?.message ?? ''} ${(error as Error)?.message ?? ''}`.toLowerCase();
  return code === 'UND_ERR_SOCKET'
    || code === 'ECONNRESET'
    || code === 'EPIPE'
    || code === 'ECONNREFUSED'
    || message.includes('other side closed')
    || message.includes('socket hang up');
}

export function createOpenRouterClient(options: OpenRouterClientOptions): LlmClient {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
  };
  if (options.siteUrl) headers['HTTP-Referer'] = options.siteUrl;
  if (options.appTitle) headers['X-Title'] = options.appTitle;

  return {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    apiKey: options.apiKey,
    headers,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

/* ------------------------------------------------------------------ */
/* Erreurs : que faut-il retenter ?                                     */
/* ------------------------------------------------------------------ */

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')) {
    return true;
  }
  return error instanceof LlmError && error.cause instanceof Error && error.cause.name === 'AbortError';
}

/**
 * Un échec qui concerne le modèle lui-même (saturation, modèle indisponible,
 * erreur du fournisseur) : on peut basculer sur le modèle suivant.
 * Les erreurs globales (clé invalide, requête invalide) ne se rejouent pas.
 */
export function isModelFailure(error: unknown): boolean {
  if (error instanceof LlmHttpError) {
    if (error.status === 401 || error.status === 403) return false;
    if (error.status === 400) return /no endpoints|model|not found|not available/i.test(error.body ?? '');
    if (error.status === 404) return true;
    if (error.status === 408 || error.status === 429) return true;
    return error.status >= 500;
  }
  if (error instanceof LlmError && error.cause instanceof Error) {
    const cause = error.cause;
    if (cause.name === 'AbortError') return false;
    // Erreur réseau : le fournisseur est injoignable, on tente le suivant.
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

export interface LlmStreamOptions {
  /** Chaîne de bascule ordonnée : le premier qui répond l'emporte. */
  models: string[];
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  maxTokens: number;
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onToolStart?: (toolCallId: string, name: string) => void;
  onToolInputDelta?: (toolCallId: string, chunk: string) => void;
  /** `false` dès qu'un événement Canvas a été émis : plus de bascule possible. */
  canRetry?: () => boolean;
  logger?: Logger;
}

const RETRY_DELAY_MS = 1000;
/** Nombre de tentatives sur une erreur de socket avant de changer de modèle. */
const MAX_SOCKET_RETRIES = 3;
/** Attentes avant chaque nouvelle tentative (backoff). */
const SOCKET_RETRY_DELAYS = [500, 1500, 3000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new LlmError('Requête annulée.'));
    }, { once: true });
  });
}

function toOpenAiTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toOpenAiMessages(system: string, messages: LlmMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }

    out.push({ role: message.role, content: message.content });
  }

  return out;
}

interface StreamedToolCall {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

/**
 * Appelle un modèle et lit son flux SSE.
 *
 * Les erreurs de socket (connexion morte, « other side closed », timeout de
 * connexion) sont transitoires : on retente sur une nouvelle connexion avec un
 * backoff, tant que rien n'a été envoyé au client. Au-delà, on laisse la
 * bascule de modèle prendre le relais.
 */
async function streamOnce(
  client: LlmClient,
  model: string,
  options: LlmStreamOptions,
  includeUsage = true,
): Promise<LlmOutcome> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_SOCKET_RETRIES; attempt += 1) {
    try {
      return await attemptStream(client, model, options, includeUsage);
    } catch (error) {
      lastError = error;
      if (isAbortError(error)) throw error;
      if (!isRetryableSocketError(error)) throw error;
      if (attempt === MAX_SOCKET_RETRIES) break;
      // On ne retente que si rien n'a été produit : sinon le texte serait
      // dupliqué dans la bulle de chat.
      if (!(options.canRetry?.() ?? true)) break;
      options.logger?.warn('llm_socket_retry', {
        model,
        attempt: attempt + 1,
        error: describeNetworkError(error),
      });
      await sleep(SOCKET_RETRY_DELAYS[attempt] ?? SOCKET_RETRY_DELAYS.at(-1)!, options.signal);
    }
  }

  throw lastError instanceof Error
    ? new LlmError(describeNetworkError(lastError), lastError)
    : new LlmError('Erreur réseau vers le fournisseur de modèle.');
}

/** Une tentative : requête + lecture du flux. */
async function attemptStream(
  client: LlmClient,
  model: string,
  options: LlmStreamOptions,
  includeUsage: boolean,
): Promise<LlmOutcome> {
  const { signal } = options;

  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(options.system, options.messages),
    tools: options.tools.map(toOpenAiTool),
    stream: true,
    max_tokens: options.maxTokens,
  };
  // OpenRouter renvoie les jetons en fin de flux sur demande.
  if (includeUsage) body.usage = { include: true };

  let response: Response;
  try {
    response = await client.fetchImpl(`${client.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: client.headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new LlmError(
      describeNetworkError(error),
      error,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = `Erreur ${response.status} du fournisseur de modèle.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* corps non JSON */
    }

    // Certains endpoints refusent le champ `usage` : on le retire et on réessaie.
    if (response.status === 400 && includeUsage && /usage/i.test(body)) {
      return streamOnce(client, model, options, false);
    }

    throw new LlmHttpError(response.status, message, body);
  }

  if (!response.body) {
    throw new LlmError('Réponse sans corps de flux.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let text = '';
  let finishReason: string | null = null;
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls = new Map<number, StreamedToolCall>();

  const handleChunk = (chunk: string): void => {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.error) {
        const message = typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error.message ?? 'Erreur du fournisseur de modèle.';
        throw new LlmError(message);
      }

      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens ?? 0,
        };
      }

      const choice = parsed.choices?.[0];
      if (!choice) return;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        options.onText?.(delta.content);
      }

      for (const call of delta.tool_calls ?? []) {
        const index: number = typeof call.index === 'number' ? call.index : 0;
        const entry = toolCalls.get(index) ?? { id: '', name: '', args: '', started: false };

        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;

        if (!entry.started && entry.name) {
          entry.started = true;
          options.onToolStart?.(entry.id || `call_${index}`, entry.name);
        }

        if (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0) {
          entry.args += call.function.arguments;
          options.onToolInputDelta?.(entry.id || `call_${index}`, call.function.arguments);
        }

        toolCalls.set(index, entry);
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const chunk = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        handleChunk(chunk);
        separator = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) handleChunk(buffer);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new LlmError(
      describeNetworkError(error),
      error,
    );
  }

  const toolUses: LlmToolUse[] = [];
  for (const [index, entry] of toolCalls) {
    if (!entry.name) continue;
    let input: unknown = {};
    if (entry.args.trim()) {
      try {
        input = JSON.parse(entry.args);
      } catch {
        input = {};
      }
    }
    toolUses.push({ id: entry.id || `call_${index}`, name: entry.name, input });
  }

  const stopReason: LlmStopReason =
    finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'length' ? 'max_tokens'
        : 'end_turn';

  return {
    stopReason,
    usage,
    toolUses,
    text,
    model,
    content: {
      role: 'assistant',
      content: text,
      toolCalls: toolUses.map((use) => ({
        id: use.id,
        name: use.name,
        arguments: JSON.stringify(use.input ?? {}),
      })),
    },
  };
}

/**
 * Ouvre un flux modèle et relaie les événements.
 * Bascule d'un modèle à l'autre tant que rien n'a été écrit dans le Canvas.
 */
export async function streamCompletion(
  client: LlmClient,
  options: LlmStreamOptions,
): Promise<LlmOutcome> {
  const logger = options.logger;
  let lastError: unknown;

  for (const model of options.models) {
    try {
      const outcome = await streamOnce(client, model, options);
      logger?.debug('llm_turn_done', {
        model,
        stop_reason: outcome.stopReason,
        input_tokens: outcome.usage.inputTokens,
        output_tokens: outcome.usage.outputTokens,
        tool_calls: outcome.toolUses.length,
      });
      return outcome;
    } catch (error) {
      if (isAbortError(error) || options.signal.aborted) throw error;
      lastError = error;

      const canContinue = (options.canRetry?.() ?? true) && isModelFailure(error);
      if (!canContinue) throw error;

      logger?.warn('llm_model_failed', {
        model,
        status: error instanceof LlmHttpError ? error.status : undefined,
        error: error instanceof Error ? error.message : String(error),
      });

      if (model !== options.models[options.models.length - 1]) {
        await sleep(RETRY_DELAY_MS, options.signal);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new LlmError('Aucun modèle disponible.');
}
