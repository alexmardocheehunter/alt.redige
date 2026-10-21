/**
 * Fake Anthropic client used by the tests.
 * It reproduces the part of the SDK used by src/llm.ts: `client.messages.stream()`.
 */
import { APIUserAbortError } from '@anthropic-ai/sdk/error';

export interface FakeToolUse {
  id: string;
  name: string;
  input: unknown;
  /** Partial JSON streamed to the client (to exercise the canvas_delta path). */
  partialJson?: string;
}

export interface FakeTurn {
  text?: string;
  toolUses?: FakeToolUse[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  inputTokens?: number;
  outputTokens?: number;
  /** Never resolves until the request is aborted (used by the cancellation test). */
  hang?: boolean;
}

export interface RecordedCall {
  model: string;
  system: unknown;
  messages: unknown;
  tools: unknown;
  max_tokens: number;
}

type Listener = (...args: any[]) => void;

const CHUNK_SIZE = 24;

function chunk(text: string): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += CHUNK_SIZE) {
    parts.push(text.slice(index, index + CHUNK_SIZE));
  }
  return parts;
}

function createFakeStream(turn: FakeTurn, options: { signal?: AbortSignal } | undefined) {
  const listeners = new Map<string, Listener[]>();

  const api = {
    on(event: string, listener: Listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return api;
    },
    finalMessage(): Promise<any> {
      const signal = options?.signal;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          reject(new APIUserAbortError({ message: 'Request aborted.' }));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        const deliver = async () => {
          try {
            if (turn.hang) {
              await new Promise<void>((_, rej) => {
                signal?.addEventListener('abort', () => rej(new APIUserAbortError({ message: 'Request aborted.' })), { once: true });
              });
            }

            if (turn.text) {
              for (const listener of listeners.get('text') ?? []) listener(turn.text, turn.text);
            }

            const content: any[] = [];
            if (turn.text) content.push({ type: 'text', text: turn.text });

            for (const [index, tool] of (turn.toolUses ?? []).entries()) {
              for (const listener of listeners.get('streamEvent') ?? []) {
                listener({
                  type: 'content_block_start',
                  index,
                  content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
                }, {} as any);
              }
              if (tool.partialJson) {
                for (const part of chunk(tool.partialJson)) {
                  for (const listener of listeners.get('inputJson') ?? []) listener(part, {});
                  await new Promise((resolve) => setTimeout(resolve, 0));
                }
              }
              content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input });
            }

            resolve({
              id: 'msg_fake',
              role: 'assistant',
              stop_reason: turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn'),
              usage: {
                input_tokens: turn.inputTokens ?? 100,
                output_tokens: turn.outputTokens ?? 50,
              },
              content,
            });
          } catch (error) {
            reject(error);
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        };

        void deliver();
      });
    },
  };

  return api;
}

export class FakeAnthropic {
  readonly calls: RecordedCall[] = [];
  readonly turns: FakeTurn[] = [];
  private index = 0;
  /** Set to true when a call was interrupted by an abort. */
  aborted = false;

  constructor(turns: FakeTurn[] = []) {
    this.turns.push(...turns);
  }

  push(turn: FakeTurn): void {
    this.turns.push(turn);
  }

  readonly messages = {
    stream: (params: any, options?: { signal?: AbortSignal }) => {
      this.calls.push({
        model: params.model,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        max_tokens: params.max_tokens,
      });
      const signal = options?.signal;
      const turn = this.turns[this.index] ?? { stopReason: 'end_turn' as const };
      this.index += 1;
      const stream = createFakeStream(turn, options);
      signal?.addEventListener('abort', () => {
        this.aborted = true;
      }, { once: true });
      return stream;
    },
  };
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
