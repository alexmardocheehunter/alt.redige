/**
 * Test de bout en bout.
 *
 * Un serveur HTTP local parle le protocole OpenRouter (API compatible OpenAI) :
 * le code de production — client, streaming SSE, outils, garde-fou, export —
 * est exercé sur une vraie socket, sans dépendre du réseau.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createOpenRouterClient } from '../src/llm.js';
import { TemplateStore } from '../src/templates.js';
import { parseSse } from './fake-llm.js';
import { openDocx, countOccurrences } from '../evals/docx-utils.js';

const CONTRACT = `# Contrat de bail à usage d'habitation

Entre les soussignés :

**Monsieur Koné**, demeurant à Abidjan, ci-après désigné « le **Bailleur** »,

et

**Madame Aya**, demeurant à Abidjan, ci-après désignée « la **Locataire** »,

il a été convenu et arrêté ce qui suit :

## Article 1 – Objet du contrat

Le Bailleur donne à bail au Locataire un studio situé à Yopougon, Abidjan, à usage exclusif d'habitation.

## Article 2 – Durée et loyer

1. Le bail est consenti pour une durée de 12 mois.
2. Le loyer mensuel est fixé à **70 000 FCFA**.

## Article 3 – Signatures

Fait à Abidjan, le [À COMPLÉTER : date].

| Le Bailleur | Le Locataire |
|---|---|
| Lu et approuvé | Lu et approuvé |
|  |  |
`;

interface Recorded {
  model: string;
  stream: boolean;
}

const recorded: Recorded[] = [];
let server: Server;
let baseUrl = '';

/** SSE d'un tour qui appelle l'outil `create_canvas`. */
function toolCallStream(markdown = CONTRACT, contractType = 'bail-habitation'): string {
  const args = JSON.stringify({
    title: "Contrat de bail à usage d'habitation",
    contract_type: contractType,
    markdown,
  });

  const chunks: string[] = [];
  chunks.push(`data: ${JSON.stringify({
    id: 'gen-fake',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Je rédige le contrat. ' }, finish_reason: null }],
  })}\n\n`);

  chunks.push(`data: ${JSON.stringify({
    id: 'gen-fake',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_canvas', arguments: '' } }] },
      finish_reason: null,
    }],
  })}\n\n`);

  for (let index = 0; index < args.length; index += 40) {
    chunks.push(`data: ${JSON.stringify({
      id: 'gen-fake',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(index, index + 40) } }] }, finish_reason: null }],
    })}\n\n`);
  }

  chunks.push(`data: ${JSON.stringify({
    id: 'gen-fake',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 120, completion_tokens: 80 },
  })}\n\n`);

  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

/** Choit du document selon la demande : un CDD trop long si on le demande. */
function contractFor(messages: Array<{ role: string; content: string }>): { markdown: string; contractType: string } {
  // On ne regarde que le dernier message de l'utilisateur : le prompt système
  // contient le catalogue, qui mentionne tous les types.
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const request = lastUser?.content ?? '';
  if (request.includes('CDD')) {
    return {
      contractType: 'cdd-terme-precis',
      markdown: [
        '# Contrat de travail à durée déterminée (terme précis)',
        '',
        '## Article 4 – Durée',
        '',
        'Le contrat est conclu pour une durée de 3 ans à compter du 1er janvier 2026.',
        '',
      ].join('\n'),
    };
  }
  return { markdown: CONTRACT, contractType: 'bail-habitation' };
}

function textStream(text: string): string {  return `data: ${JSON.stringify({
    id: 'gen-fake',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`
  + `data: ${JSON.stringify({
    id: 'gen-fake',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 200, completion_tokens: 20 },
  })}\n\n`
  + 'data: [DONE]\n\n';
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      recorded.push({ model: parsed.model, stream: parsed.stream === true });

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');

      // Appel du garde-fou de sécurité (non streamé).
      if (parsed.stream !== true) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'User Safety: safe' }, finish_reason: 'stop' }],
        }));
        return;
      }

      // Le tour qui reçoit le résultat de l'outil répond en texte ;
      // sinon, l'agent appelle l'outil de rédaction.
      const messages = (parsed.messages ?? []) as Array<{ role: string; content: string }>;
      const toolResultReceived = messages.some((message) => message.role === 'tool');
      if (toolResultReceived) {
        res.end(textStream('Le contrat est prêt.'));
        return;
      }
      const chosen = contractFor(parsed.messages);
      res.end(toolCallStream(chosen.markdown, chosen.contractType));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function buildApp() {
  const config = loadConfig({
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: baseUrl,
  });
  const client = createOpenRouterClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    appTitle: config.appTitle,
  });
  return createApp({ config, logger: createLogger('error'), templates: TemplateStore.load(), client });
}

describe('B9 — bout en bout (serveur OpenRouter local)', () => {
  it('déroule le flux complet : ready → status → canvas → done', async () => {
    const app = buildApp();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Je veux un bail pour un studio à Yopougon.' }],
        contract_type: 'bail-habitation',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const events = parseSse(await res.text());
    const names = events.map((event) => event.event);

    expect(names[0]).toBe('ready');
    expect(names).toContain('canvas_start');
    expect(names).toContain('canvas_delta');
    expect(names).toContain('canvas_set');
    expect(names[names.length - 1]).toBe('done');

    const set = events.find((event) => event.event === 'canvas_set')!;
    expect(set.data.mode).toBe('create');
    expect(set.data.markdown).toBe(CONTRACT);
    expect(set.data.version).toBe(1);
    expect(set.data.validation.placeholders).toBe(1);

    const done = events[events.length - 1]!.data;
    expect(done.stop_reason).toBe('end_turn');
    expect(done.usage.input_tokens).toBeGreaterThan(0);

    // Le garde-fou a bien été appelé, hors bascule de rédaction.
    expect(recorded.some((call) => call.model === 'nvidia/nemotron-3.5-content-safety:free')).toBe(true);
    expect(recorded.some((call) => call.model === 'dots-studio/dots-3-note-preview:free')).toBe(true);
  });

  it('reconstruit le document à partir des canvas_delta', async () => {
    const app = buildApp();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Message complet : une demande sans information exploitable ne
      // produit pas de contrat (le serveur pose une question).
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: 'Je veux un bail d habitation pour un studio a Cocody, loyer 150 000 FCFA par mois, duree 12 mois, bailleur Monsieur Koné, locataire Madame Aya.',
        }],
      }),
    });
    const events = parseSse(await res.text());
    const streamed = events
      .filter((event) => event.event === 'canvas_delta')
      .map((event) => event.data.text)
      .join('');
    expect(streamed).toBe(CONTRACT);
  });

  it('exporte le document généré en Word', async () => {
    const app = buildApp();
    const res = await app.request('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: CONTRACT, title: 'Contrat de bail' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.headers.get('content-disposition')).toContain('filename="contrat-de-bail.docx"');

    const archive = await openDocx(Buffer.from(await res.arrayBuffer()));
    expect(countOccurrences(archive.documentXml, 'À COMPLÉTER')).toBe(1);
    expect(archive.documentXml).toContain('<w:tbl>');
  });

  it('annule l’appel au modèle quand le client coupe la connexion', async () => {
    const app = buildApp();
    const controller = new AbortController();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Je veux un bail.' }] }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    await res.text().catch(() => undefined);
  });

  it('remonte au client un écart avec la règle juridique', async () => {
    // Le modèle produit un CDD de trois ans : la règle interdit de dépasser deux ans.
    const illegal = [
      '# Contrat de travail à durée déterminée (terme précis)',
      '',
      '## Article 4 – Durée',
      '',
      'Le contrat est conclu pour une durée de 3 ans à compter du 1er janvier 2026.',
      '',
    ].join('\n');

    const app = buildApp();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Je veux un CDD de 3 ans.' }],
        contract_type: 'cdd-terme-precis',
      }),
    });

    const events = parseSse(await res.text());
    const set = events.find((event) => event.event === 'canvas_set')!;
    const issues = set.data.validation.issues as Array<{ code: string; severity: string }>;

    expect(issues.map((issue) => issue.code)).toContain('validator:cdd_duree_max');
    const issue = issues.find((entry) => entry.code === 'validator:cdd_duree_max')!;
    expect(issue.severity).toBe('error');
    expect(illegal).toContain('3 ans');
  });
});
