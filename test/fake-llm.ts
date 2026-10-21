/**
 * Faux client OpenRouter utilisé par les tests.
 *
 * Il reproduit la partie de l'API utilisée par src/llm.ts :
 * `POST /chat/completions` avec un flux SSE au format OpenAI.
 */
import type { LlmClient } from '../src/llm.js';

export interface FakeToolUse {
  id: string;
  name: string;
  input: unknown;
  /** JSON partiel diffusé au client (pour exercer le chemin canvas_delta). */
  partialJson?: string;
}

export interface FakeTurn {
  text?: string;
  toolUses?: FakeToolUse[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  inputTokens?: number;
  outputTokens?: number;
  /** Ne répond jamais avant l'annulation (test d'annulation). */
  hang?: boolean;
  /** Le fournisseur répond en erreur HTTP. */
  httpError?: { status: number; body?: string };
}

export interface RecordedCall {
  model: string;
  messages: unknown;
  tools: unknown;
  max_tokens: number;
  stream: boolean;
}

const CHUNK_SIZE = 24;

function chunk(text: string): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += CHUNK_SIZE) {
    parts.push(text.slice(index, index + CHUNK_SIZE));
  }
  return parts;
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Builds the SSE body of a fake OpenRouter answer. */
export function buildSseBody(turn: FakeTurn, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (value: string) => controller.enqueue(encoder.encode(value));

      if (turn.httpError) {
        controller.error(new Error(`HTTP ${turn.httpError.status}`));
        return;
      }

      if (turn.hang) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        controller.error(new DOMException('Aborted', 'AbortError'));
        return;
      }

      if (turn.text) {
        push(sseEvent({
          id: 'chatcmpl-fake',
          choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }],
        }));
      }

      for (const [index, tool] of (turn.toolUses ?? []).entries()) {
        push(sseEvent({
          id: 'chatcmpl-fake',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index,
                id: tool.id,
                type: 'function',
                function: { name: tool.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }],
        }));

        // Without an explicit streaming, the whole arguments are sent at once.
        const payload = tool.partialJson ?? JSON.stringify(tool.input ?? {});
        for (const part of chunk(payload)) {
          push(sseEvent({
            id: 'chatcmpl-fake',
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: part } }] },
              finish_reason: null,
            }],
          }));
        }
      }

      push(sseEvent({
        id: 'chatcmpl-fake',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: turn.finishReason ?? (turn.toolUses?.length ? 'tool_calls' : 'stop'),
        }],
        usage: {
          prompt_tokens: turn.inputTokens ?? 100,
          completion_tokens: turn.outputTokens ?? 50,
          total_tokens: (turn.inputTokens ?? 100) + (turn.outputTokens ?? 50),
        },
      }));

      push('data: [DONE]\n\n');
      controller.close();
    },
  });
}

export interface FakeOptions {
  turns: FakeTurn[];
  /** Réponse du modèle de sécurité. */
  safetyVerdict?: string;
}

/** Builds an LlmClient backed by the fake. */
export function fakeClient(fake: FakeOpenRouter): LlmClient {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-key',
    headers: { 'Content-Type': 'application/json' },
    fetchImpl: fake.fetchImpl,
  };
}

export class FakeOpenRouter {
  readonly calls: RecordedCall[] = [];
  readonly safetyCalls: Array<{ model: string; content: string; maxTokens?: number }> = [];
  /** `true` quand un appel a été interrompu par une annulation. */
  aborted = false;
  private index = 0;

  constructor(private readonly options: FakeOptions) {}

  get turns(): FakeTurn[] {
    return this.options.turns;
  }

  /** Client injecté à la place du vrai client OpenRouter. */
  readonly fetchImpl: typeof fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const signal = init?.signal as AbortSignal | undefined;

    if (url.endsWith('/chat/completions') && body.stream === false) {
      // Appel du modèle de sécurité.
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
      this.safetyCalls.push({
        model: body.model,
        content: messages.map((message) => message.content).join('\n'),
        maxTokens: body.max_tokens,
      });
      const verdict = this.options.safetyVerdict ?? 'SAFE';
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fake',
          choices: [{ index: 0, message: { role: 'assistant', content: verdict }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    this.calls.push({
      model: body.model,
      messages: body.messages,
      tools: body.tools,
      max_tokens: body.max_tokens,
      stream: body.stream,
    });

    const turn = this.options.turns[this.index] ?? { finishReason: 'stop' as const };
    this.index += 1;

    signal?.addEventListener('abort', () => {
      this.aborted = true;
    }, { once: true });

    if (turn.httpError) {
      return new Response(turn.httpError.body ?? JSON.stringify({ error: { message: 'erreur' } }), {
        status: turn.httpError.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(buildSseBody(turn, signal), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

/** Parses an SSE payload into a list of `{ event, data }`. */
export function parseSse(payload: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const block of payload.split(/\n\n/)) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    let event = 'message';
    let data = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      out.push({ event, data: JSON.parse(data) });
    } catch {
      out.push({ event, data });
    }
  }
  return out;
}
