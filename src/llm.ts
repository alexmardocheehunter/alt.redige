/**
 * Anthropic client — the only file that knows about the model provider.
 * Changing provider must not touch anything else.
 */
import Anthropic from '@anthropic-ai/sdk';
import { APIUserAbortError } from '@anthropic-ai/sdk/error';
import type {
  ContentBlock,
  MessageParam,
  StopReason,
  Tool,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type { Logger } from './logger.js';

export interface LlmToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmOutcome {
  stopReason: StopReason | null;
  usage: LlmUsage;
  toolUses: LlmToolUse[];
  text: string;
  /** Raw content blocks of the assistant message (to echo it back to the model). */
  content: ContentBlock[];
}

export interface LlmStreamOptions {
  model: string;
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  maxTokens: number;
  signal: AbortSignal;
  /** Called for every text delta of the assistant. */
  onText?: (delta: string) => void;
  /** Called when a tool block starts (its name is known). */
  onToolStart?: (toolUseId: string, name: string) => void;
  /** Called for every chunk of the JSON arguments of a tool. */
  onToolInputDelta?: (partialJson: string) => void;
  /** Returns false when a retry is no longer allowed (a canvas event was already sent). */
  canRetry?: () => boolean;
  logger?: Logger;
}

export class LlmError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof Anthropic.APIUserAbortError;
}

/** True for the provider errors worth a single retry (429, 5xx, overload). */
export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500) return true;
    return false;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('overloaded') || message.includes('rate limit') || message.includes('timeout');
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0 });
}

const RETRY_DELAY_MS = 1000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Annulé.'));
    }, { once: true });
  });
}

/**
 * Opens a model stream and relays the events.
 * A single retry is attempted on a transient provider error, and only while
 * `canRetry()` allows it (nothing has been written to the canvas yet).
 */
export async function streamCompletion(
  client: Anthropic,
  options: LlmStreamOptions,
): Promise<LlmOutcome> {
  const { model, system, messages, tools, maxTokens, signal } = options;
  const logger = options.logger;
  let attempt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    let text = '';
    let toolUses: LlmToolUse[] = [];
    const partialJsonByTool = new Map<string, string>();

    try {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools,
        },
        { signal },
      );

      stream.on('text', (delta) => {
        text += delta;
        options.onText?.(delta);
      });

      stream.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        const block = event.content_block;
        if (block.type !== 'tool_use') return;
        options.onToolStart?.(block.id, block.name);
      });

      stream.on('inputJson', (partialJson) => {
        options.onToolInputDelta?.(partialJson);
      });

      const message = await stream.finalMessage();

      for (const block of message.content) {
        if (block.type === 'tool_use') {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      const usage: LlmUsage = {
        inputTokens: message.usage?.input_tokens ?? 0,
        outputTokens: message.usage?.output_tokens ?? 0,
      };

      logger?.debug('llm_turn_done', {
        stop_reason: message.stop_reason,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        tool_calls: toolUses.length,
      });

      return {
        stopReason: message.stop_reason ?? null,
        usage,
        toolUses,
        text,
        content: message.content,
      };
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;

      const canRetry = attempt === 1 && (options.canRetry?.() ?? true);
      if (canRetry && isRetryableProviderError(error)) {
        logger?.warn('llm_retry', {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }

      throw new LlmError(
        error instanceof Error ? error.message : 'Erreur du fournisseur de modèle.',
        error,
      );
    }
  }
}

/** Extracts the text blocks of a message (used by the tests and the evals). */
export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** Extracts the tool-use blocks of a message. */
export function toolUsesOf(blocks: ContentBlock[]): ToolUseBlock[] {
  return blocks.filter((block): block is ToolUseBlock => block.type === 'tool_use');
}
