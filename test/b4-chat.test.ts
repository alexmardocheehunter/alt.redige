import { describe, expect, it } from 'vitest';
import { testApp, readJson, delay } from './helpers.js';
import { FakeOpenRouter, fakeClient, parseSse, type FakeTurn } from './fake-llm.js';
import { SAMPLE_BAIL } from './fixtures.js';

const CONTRACT_MARKDOWN = '# Contrat de bail à usage d\'habitation\n\n## Article 1 – Objet du contrat\n\nTexte.\n';

/** Demande exploitable : sans elle, le garde-fou refuse de rédiger. */
const COMPLETE_REQUEST =
  'Je veux un bail d habitation pour un studio a Yopougon (Abidjan), loyer 70 000 FCFA par mois, '
  + 'duree 12 mois. Le bailleur est Monsieur Kone et la locataire est Madame Aya.';

function appWith(client: FakeOpenRouter, overrides = {}) {
  return testApp(overrides, { client: fakeClient(client) });
}

async function postChat(app: ReturnType<typeof testApp>, body: unknown, init: RequestInit = {}) {
  return app.request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

describe('B4 — en-têtes SSE', () => {
  it('renvoie les en-têtes imposés par le contrat', async () => {
    const client = new FakeOpenRouter({ turns: [{ text: 'Bonjour.' }] });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: 'Bonjour' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.text();
  });
});

describe('B4 — flux de création', () => {
  it('reproduit le flux du contrat', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          text: 'Je prépare votre contrat. ',
          toolUses: [{
            id: 'tool_1',
            name: 'create_canvas',
            input: { title: 'Contrat de bail', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN },
            partialJson: JSON.stringify({
              title: 'Contrat de bail',
              contract_type: 'bail-habitation',
              markdown: CONTRACT_MARKDOWN,
            }),
          }],
          finishReason: 'tool_calls',
        },
        { text: 'V1 prête.' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());
    const names = events.map((event) => event.event);

    expect(names[0]).toBe('ready');
    expect(names).toContain('canvas_start');
    expect(names).toContain('canvas_delta');
    expect(names).toContain('canvas_set');
    expect(names[names.length - 1]).toBe('done');

    const start = events.find((event) => event.event === 'canvas_start')!;
    expect(start.data.mode).toBe('create');
    expect(start.data.title).toBe('Contrat de bail');
    expect(start.data.contract_type).toBe('bail-habitation');

    const set = events.find((event) => event.event === 'canvas_set')!;
    expect(set.data.mode).toBe('create');
    expect(set.data.markdown).toBe(CONTRACT_MARKDOWN);
    expect(set.data.version).toBe(1);
    expect(set.data.validation.placeholders).toBe(0);
    // The test contract only has one article: the missing ones are reported as warnings.
    expect(set.data.validation.issues.map((issue: any) => issue.code)).toContain('missing_article');

    const done = events[events.length - 1]!.data;
    expect(done.stop_reason).toBe('end_turn');
    expect(done.usage.input_tokens).toBeGreaterThan(0);
  });

  it('reconstruit le document à partir des canvas_delta', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_1',
            name: 'create_canvas',
            input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN },
            partialJson: JSON.stringify({
              title: 'T',
              contract_type: 'bail-habitation',
              markdown: CONTRACT_MARKDOWN,
            }),
          }],
          finishReason: 'tool_calls',
        },
        { text: 'Terminé.' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());
    const streamed = events
      .filter((event) => event.event === 'canvas_delta')
      .map((event) => event.data.text)
      .join('');
    expect(streamed).toBe(CONTRACT_MARKDOWN);
  });

  it('termine par done, sans error, quand la phrase de clôture échoue après un canvas_set', async () => {
    // Constaté en production : le document est livré, puis l'appel de clôture
    // échoue (réseau) et le flux se terminait par `error`. Le front, qui
    // restaure le document précédent sur `error`, jetait un contrat valide.
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_1',
            name: 'create_canvas',
            input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN },
          }],
          finishReason: 'tool_calls',
        },
        { httpError: { status: 503 } },
        { httpError: { status: 503 } },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());

    expect(events.some((event) => event.event === 'canvas_set')).toBe(true);
    expect(events.filter((event) => event.event === 'error')).toHaveLength(0);
    const done = events.find((event) => event.event === 'done')!;
    expect(done.data.stop_reason).toBe('end_turn');
    expect(events[events.length - 1]!.event).toBe('done');
  });

  it('signale l’erreur quand aucun document n’a été produit', async () => {
    const client = new FakeOpenRouter({
      turns: [{ httpError: { status: 503 } }, { httpError: { status: 503 } }],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());
    expect(events.some((event) => event.event === 'error')).toBe(true);
  });

  it('incrémente la version à chaque canvas_set', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_1',
            name: 'create_canvas',
            input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN, replace: true },
          }],
          finishReason: 'tool_calls',
        },
        { text: 'OK' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: COMPLETE_REQUEST }],
      document: { markdown: '# Ancien', version: 7 },
    });
    const events = parseSse(await res.text());
    const set = events.find((event) => event.event === 'canvas_set')!;
    expect(set.data.version).toBe(8);
  });

  it('refuse de remplacer un document existant sans replace=true', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_1',
            name: 'create_canvas',
            input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN },
          }],
          finishReason: 'tool_calls',
        },
        { text: 'Je dois utiliser edit_canvas.' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: COMPLETE_REQUEST }],
      document: { markdown: '# Ancien', version: 7 },
    });
    const events = parseSse(await res.text());
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(0);
  });
});

describe('B4 — flux d’édition', () => {
  it('émet canvas_start puis canvas_set en mode edit', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_2',
            name: 'edit_canvas',
            input: {
              edits: [{ old_str: '[À COMPLÉTER : durée du préavis]', new_str: 'trois (3) mois' }],
            },
          }],
          finishReason: 'tool_calls',
        },
        { text: 'Préavis mis à jour.' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'Change le préavis en 3 mois' }],
      document: { markdown: SAMPLE_BAIL, version: 3 },
    });
    const events = parseSse(await res.text());
    const start = events.find((event) => event.event === 'canvas_start')!;
    expect(start.data.mode).toBe('edit');
    const set = events.find((event) => event.event === 'canvas_set')!;
    expect(set.data.mode).toBe('edit');
    expect(set.data.edits_applied).toBe(1);
    expect(set.data.version).toBe(4);
    expect(set.data.markdown).toContain('trois (3) mois');
    expect(set.data.validation.placeholders).toBe(7);
  });

  it('renvoie le document à jour au modèle après une modification', async () => {
    // Sans cela, le modèle continue sur l'état précédent et réédite la même
    // clause (constaté en campagne réelle : quatre `edit_canvas` successifs).
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_2',
            name: 'edit_canvas',
            input: {
              edits: [{ old_str: '[À COMPLÉTER : durée du préavis]', new_str: 'trois (3) mois' }],
            },
          }],
          finishReason: 'tool_calls',
        },
        { text: 'Préavis mis à jour.' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'Change le préavis en 3 mois' }],
      document: { markdown: SAMPLE_BAIL, version: 3 },
    });
    await res.text();

    expect(client.calls.length).toBeGreaterThanOrEqual(2);
    const secondCall = client.calls[1]!;
    const messages = secondCall.messages as Array<{ role: string; content: string }>;
    const update = messages.filter((message) => message.role === 'user').at(-1)!;

    expect(update.content).toContain('<document_courant version="4">');
    expect(update.content).toContain('trois (3) mois');
    expect(update.content).not.toContain('[À COMPLÉTER : durée du préavis]');
  });

  it('ne modifie rien quand old_str est introuvable', async () => {
    const client = new FakeOpenRouter({
      turns: [
        {
          toolUses: [{
            id: 'tool_2',
            name: 'edit_canvas',
            input: { edits: [{ old_str: 'texte absent', new_str: 'x' }] },
          }],
          finishReason: 'tool_calls',
        },
        { text: 'Je ne trouve pas cette phrase.' },
      ],
    });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'Change quelque chose' }],
      document: { markdown: SAMPLE_BAIL, version: 1 },
    });
    const events = parseSse(await res.text());
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(0);
    expect(events[events.length - 1]!.event).toBe('done');
  });
});

describe('B4 — erreurs', () => {
  it('refuse des rôles non alternés', async () => {
    const client = new FakeOpenRouter({ turns: [] });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('bad_request');
  });

  it('refuse un dernier message assistant', async () => {
    const client = new FakeOpenRouter({ turns: [] });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'assistant', content: 'a' }] });
    expect(res.status).toBe(400);
  });

  it('refuse un document trop long', async () => {
    const client = new FakeOpenRouter({ turns: [] });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'a' }],
      document: { markdown: 'x'.repeat(200_001), version: 1 },
    });
    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.error.code).toBe('payload_too_large');
  });

  it('refuse un message trop long', async () => {
    const client = new FakeOpenRouter({ turns: [] });
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'x'.repeat(8001) }],
    });
    expect(res.status).toBe(413);
  });

  it('refuse un corps JSON invalide', async () => {
    const client = new FakeOpenRouter({ turns: [] });
    const app = appWith(client);
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'pas du json',
    });
    expect(res.status).toBe(400);
  });

  it('émet un événement error quand le contrat est tronqué', async () => {
    const client = new FakeOpenRouter({
      turns: [{
        text: 'Je commence',
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'T', contract_type: 'bail-habitation', markdown: '# Titre' },
        }],
        finishReason: 'length',
      }],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());
    const error = events.find((event) => event.event === 'error')!;
    expect(error.data.code).toBe('truncated');
    expect(error.data.retryable).toBe(true);
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(0);
  });
});

describe('B4 — le contrat ne doit pas être écrit dans le chat', () => {
  it('ne relaie pas un texte qui ressemble à un contrat et émet un avertissement', async () => {
    // Le modèle écrit le contrat dans le chat au lieu du Canvas : c'est le
    // défaut mesuré en campagne réelle (1 127 caractères).
    const client = new FakeOpenRouter({
      turns: [{
        text: 'Voici le contrat :\n\n## Article 1 – Objet du contrat\n\n'
          + 'Le Bailleur donne à bail un studio, loyer 70 000 FCFA par mois, 12 mois.\n\n'
          + '## Article 2 – Durée\n\nLe bail est conclu pour 12 mois.\n',
        finishReason: 'stop',
      }],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());

    const chat = events
      .filter((event) => event.event === 'text_delta')
      .map((event) => event.data.text)
      .join('');

    expect(chat).not.toMatch(/##\s*Article/);
    expect(chat).not.toContain('70 000 FCFA');
    expect(chat.length).toBeLessThanOrEqual(600);

    const warning = events.find((event) => event.event === 'warning');
    expect(warning).toBeDefined();
    expect(warning!.data.code).toBe('contract_in_chat');
  });

  it('relaye un message normal', async () => {
    const client = new FakeOpenRouter({
      turns: [{ text: 'Le bail est prêt : il reste deux champs à compléter.', finishReason: 'stop' }],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());

    const chat = events
      .filter((event) => event.event === 'text_delta')
      .map((event) => event.data.text)
      .join('');

    expect(chat).toContain('Le bail est prêt');
    expect(events.find((event) => event.event === 'warning')).toBeUndefined();
  });

  it('écourte un chat trop long et le signale', async () => {
    const client = new FakeOpenRouter({
      turns: [{ text: 'a'.repeat(1_500), finishReason: 'stop' }],
    });
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());

    const chat = events
      .filter((event) => event.event === 'text_delta')
      .map((event) => event.data.text)
      .join('');

    expect(chat.length).toBe(600);

    const warning = events.find((event) => event.event === 'warning');
    expect(warning).toBeDefined();
    expect(warning!.data.code).toBe('chat_too_long');
  });
});

describe('B4 — annulation', () => {
  it('interrompt l’appel au modèle quand la connexion est coupée', async () => {
    const client = new FakeOpenRouter({ turns: [{ hang: true }] });
    const app = appWith(client);

    const controller = new AbortController();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: COMPLETE_REQUEST }] }),
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(client.aborted).toBe(false);

    // The client closes the connection.
    controller.abort();
    await res.text().catch(() => undefined);
    await delay(100);

    // The model call has been interrupted.
    expect(client.aborted).toBe(true);
  });
});

describe('B4 — bascule entre modèles', () => {
  it('bascule sur le modèle suivant quand le premier échoue', async () => {
    const turns: FakeTurn[] = [
      { httpError: { status: 429, body: JSON.stringify({ error: { message: 'No endpoints available' } }) } },
      { text: 'Je vous réponds depuis le second modèle.' },
    ];
    const client = new FakeOpenRouter({ turns });
    const app = appWith(client, {
      models: ['minimax/minimax-m3.1-flash:free', 'nvidia/nemotron-3.5-super-vl:free'],
    });

    const res = await postChat(app, { messages: [{ role: 'user', content: 'Bonjour' }] });
    const events = parseSse(await res.text());
    expect(events[events.length - 1]!.event).toBe('done');
    expect(client.calls.map((call) => call.model)).toEqual([
      'minimax/minimax-m3.1-flash:free',
      'nvidia/nemotron-3.5-super-vl:free',
    ]);
  });

  it('ne rebascule pas une fois le contrat commencé', async () => {
    const turns: FakeTurn[] = [
      {
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN },
          partialJson: JSON.stringify({
            title: 'T',
            contract_type: 'bail-habitation',
            markdown: CONTRACT_MARKDOWN,
          }),
        }],
        finishReason: 'tool_calls',
      },
      { httpError: { status: 500 } },
    ];
    const client = new FakeOpenRouter({ turns });
    const app = appWith(client, {
      models: ['minimax/minimax-m3.1-flash:free', 'nvidia/nemotron-3.5-super-vl:free'],
    });

    const res = await postChat(app, { messages: [{ role: 'user', content: COMPLETE_REQUEST }] });
    const events = parseSse(await res.text());
    // Le second modèle n'a pas été tenté : le Canvas avait déjà commencé.
    expect(client.calls).toHaveLength(2);
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(1);
  });
});
