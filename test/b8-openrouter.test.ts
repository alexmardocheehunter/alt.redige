import { describe, expect, it } from 'vitest';
import { FakeOpenRouter, fakeClient } from './fake-llm.js';
import { isModelFailure, LlmHttpError, LlmError } from '../src/llm.js';

describe('isModelFailure', () => {
  it('considère les saturations et erreurs serveur comme des échecs de modèle', () => {
    expect(isModelFailure(new LlmHttpError(429, 'trop de requêtes'))).toBe(true);
    expect(isModelFailure(new LlmHttpError(500, 'erreur serveur'))).toBe(true);
    expect(isModelFailure(new LlmHttpError(404, 'modèle inconnu'))).toBe(true);
    expect(isModelFailure(new LlmHttpError(503, 'indisponible'))).toBe(true);
  });

  it('ne rejoue pas les erreurs globales', () => {
    expect(isModelFailure(new LlmHttpError(401, 'clé invalide'))).toBe(false);
    expect(isModelFailure(new LlmHttpError(403, 'interdit'))).toBe(false);
  });

  it('rejoue les erreurs réseau', () => {
    const cause = new TypeError('fetch failed');
    expect(isModelFailure(new LlmError('réseau', cause))).toBe(true);
  });

  it('ne rejoue pas une annulation', () => {
    const cause = new Error('Aborted');
    cause.name = 'AbortError';
    expect(isModelFailure(new LlmError('annulé', cause))).toBe(false);
  });
});

describe('bascule de modèles', () => {
  it('tente le modèle suivant après une saturation', async () => {
    const fake = new FakeOpenRouter({
      turns: [
        { httpError: { status: 429, body: '{"error":{"message":"No endpoints available"}}' } },
        { text: 'Deuxième modèle' },
      ],
    });

    const { streamCompletion } = await import('../src/llm.js');
    const outcome = await streamCompletion(fakeClient(fake), {
      models: ['a/free', 'b/free'],
      system: 'sys',
      messages: [{ role: 'user', content: 'bonjour' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    });

    expect(outcome.model).toBe('b/free');
    expect(outcome.text).toBe('Deuxième modèle');
    expect(fake.calls.map((call) => call.model)).toEqual(['a/free', 'b/free']);
  });

  it('s’arrête sur une erreur globale', async () => {
    const fake = new FakeOpenRouter({
      turns: [{ httpError: { status: 401, body: '{"error":{"message":"invalid key"}}' } }],
    });

    const { streamCompletion } = await import('../src/llm.js');
    await expect(streamCompletion(fakeClient(fake), {
      models: ['a/free', 'b/free'],
      system: 'sys',
      messages: [{ role: 'user', content: 'bonjour' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    })).rejects.toThrow();

    expect(fake.calls).toHaveLength(1);
  });

  it('respecte canRetry (pas de bascule après un événement Canvas)', async () => {
    const fake = new FakeOpenRouter({
      turns: [
        { httpError: { status: 500 } },
        { text: 'deuxième modèle' },
      ],
    });

    const { streamCompletion } = await import('../src/llm.js');
    await expect(streamCompletion(fakeClient(fake), {
      models: ['a/free', 'b/free'],
      system: 'sys',
      messages: [{ role: 'user', content: 'bonjour' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
      canRetry: () => false,
    })).rejects.toThrow();

    expect(fake.calls).toHaveLength(1);
  });

  it('retire le champ usage si le fournisseur le refuse', async () => {
    let call = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: "unknown field 'usage'" } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as typeof fetch;

    const { streamCompletion, createOpenRouterClient } = await import('../src/llm.js');
    const client = createOpenRouterClient({
      baseUrl: 'https://example.test/api/v1',
      apiKey: 'k',
      fetchImpl,
    });

    const outcome = await streamCompletion(client, {
      models: ['a/free'],
      system: 'sys',
      messages: [{ role: 'user', content: 'bonjour' }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    });

    expect(outcome.text).toBe('ok');
    expect(bodies[0]!.usage).toEqual({ include: true });
    expect(bodies[1]!.usage).toBeUndefined();
  });
});
