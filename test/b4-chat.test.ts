import { describe, expect, it } from 'vitest';
import { testApp, readJson, delay } from './helpers.js';
import { FakeAnthropic, parseSse } from './fake-llm.js';
import { SAMPLE_BAIL } from './fixtures.js';

const CONTRACT_MARKDOWN = '# Contrat de bail à usage d\'habitation\n\n## Article 1 – Objet du contrat\n\nTexte.\n';

function appWith(client: FakeAnthropic, overrides = {}) {
  return testApp(overrides, { client: client as never });
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
    const client = new FakeAnthropic([{ text: 'Bonjour.' }]);
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
    const client = new FakeAnthropic([
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
        stopReason: 'tool_use',
      },
      { text: 'V1 prête.' },
    ]);
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: 'Je veux un bail' }] });
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
    const client = new FakeAnthropic([
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
        stopReason: 'tool_use',
      },
      { text: 'Terminé.' },
    ]);
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: 'Bail' }] });
    const events = parseSse(await res.text());
    const streamed = events
      .filter((event) => event.event === 'canvas_delta')
      .map((event) => event.data.text)
      .join('');
    expect(streamed).toBe(CONTRACT_MARKDOWN);
  });

  it('incrémente la version à chaque canvas_set', async () => {
    const client = new FakeAnthropic([
      {
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN, replace: true },
        }],
        stopReason: 'tool_use',
      },
      { text: 'OK' },
    ]);
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'Bail' }],
      document: { markdown: '# Ancien', version: 7 },
    });
    const events = parseSse(await res.text());
    const set = events.find((event) => event.event === 'canvas_set')!;
    expect(set.data.version).toBe(8);
  });

  it('refuse de remplacer un document existant sans replace=true', async () => {
    const client = new FakeAnthropic([
      {
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'T', contract_type: 'bail-habitation', markdown: CONTRACT_MARKDOWN },
        }],
        stopReason: 'tool_use',
      },
      { text: 'Je dois utiliser edit_canvas.' },
    ]);
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'Bail' }],
      document: { markdown: '# Ancien', version: 7 },
    });
    const events = parseSse(await res.text());
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(0);
  });
});

describe('B4 — flux d’édition', () => {
  it('émet canvas_start puis canvas_set en mode edit', async () => {
    const client = new FakeAnthropic([
      {
        toolUses: [{
          id: 'tool_2',
          name: 'edit_canvas',
          input: {
            edits: [{ old_str: '[À COMPLÉTER : durée du préavis]', new_str: 'trois (3) mois' }],
          },
        }],
        stopReason: 'tool_use',
      },
      { text: 'Préavis mis à jour.' },
    ]);
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

  it('ne modifie rien quand old_str est introuvable', async () => {
    const client = new FakeAnthropic([
      {
        toolUses: [{
          id: 'tool_2',
          name: 'edit_canvas',
          input: { edits: [{ old_str: 'texte absent', new_str: 'x' }] },
        }],
        stopReason: 'tool_use',
      },
      { text: 'Je ne trouve pas cette phrase.' },
    ]);
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
    const client = new FakeAnthropic();
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
    const client = new FakeAnthropic();
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'assistant', content: 'a' }] });
    expect(res.status).toBe(400);
  });

  it('refuse un document trop long', async () => {
    const client = new FakeAnthropic();
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
    const client = new FakeAnthropic();
    const app = appWith(client);
    const res = await postChat(app, {
      messages: [{ role: 'user', content: 'x'.repeat(8001) }],
    });
    expect(res.status).toBe(413);
  });

  it('refuse un corps JSON invalide', async () => {
    const client = new FakeAnthropic();
    const app = appWith(client);
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'pas du json',
    });
    expect(res.status).toBe(400);
  });

  it('émet un événement error quand le contrat est tronqué', async () => {
    const client = new FakeAnthropic([
      {
        text: 'Je commence',
        toolUses: [{
          id: 'tool_1',
          name: 'create_canvas',
          input: { title: 'T', contract_type: 'bail-habitation', markdown: '# Titre' },
        }],
        stopReason: 'max_tokens',
      },
    ]);
    const app = appWith(client);
    const res = await postChat(app, { messages: [{ role: 'user', content: 'Bail' }] });
    const events = parseSse(await res.text());
    const error = events.find((event) => event.event === 'error')!;
    expect(error.data.code).toBe('truncated');
    expect(error.data.retryable).toBe(true);
    expect(events.filter((event) => event.event === 'canvas_set')).toHaveLength(0);
  });
});

describe('B4 — annulation', () => {
  it('interrompt l’appel au modèle quand la connexion est coupée', async () => {
    const client = new FakeAnthropic([{ hang: true }]);
    const app = appWith(client);

    const controller = new AbortController();
    const res = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Bail' }] }),
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
