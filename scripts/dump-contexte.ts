/**
 * Produit le contexte réellement envoyé au modèle, pour une première et une
 * deuxième question.
 *
 * Un serveur local parle le protocole OpenRouter : chaque requête reçue est
 * capturée telle quelle. Le résultat est donc le payload exact qui partirait
 * sur le réseau — pas une reconstruction.
 *
 *   npx tsx scripts/dump-contexte.ts
 *
 * Sortie :
 *   docs/contexte-modele/1-premiere-question.json
 *   docs/contexte-modele/2-deuxieme-question.json
 *   docs/CONTEXTE-MODELE.md
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createOpenRouterClient } from '../src/llm.js';
import { TemplateStore } from '../src/templates.js';

const OUT_DIR = resolve(process.cwd(), 'docs', 'contexte-modele');
const CAPTURE_DIR = resolve(process.cwd(), 'tmp', 'contexte-capture');

rmSync(CAPTURE_DIR, { recursive: true, force: true });
process.env.LLM_DEBUG_DIR = CAPTURE_DIR;

const CONTRACT = `# Contrat de bail à usage d'habitation

Entre les soussignés :

**Monsieur Koné**, demeurant à Abidjan, ci-après désigné « le **Bailleur** »,

et

**Madame Aya**, demeurant à Abidjan, ci-après désignée « la **Locataire** »,

il a été convenu et arrêté ce qui suit :

## Article 1 – Objet du contrat

Le Bailleur donne à bail à la Locataire un studio situé à Yopougon, Abidjan, à usage exclusif d'habitation.

## Article 2 – Durée et loyer

1. Le bail est consenti pour une durée de 12 mois.
2. Le loyer mensuel est fixé à **70 000 FCFA**.

## Article 3 – Signatures

Fait à Abidjan, le [À COMPLÉTER : date].

| Le Bailleur | La Locataire |
|---|---|
| Lu et approuvé | Lu et approuvé |
`;

/* --- serveur local qui parle le protocole OpenRouter ------------------ */

const captured: Array<{ kind: string; model: string; body: any }> = [];

function sse(turns: Array<{ text?: string; tool?: { name: string; args: unknown } }>): string {
  const events: string[] = [];
  for (const turn of turns) {
    if (turn.text) {
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n\n`);
    }
    if (turn.tool) {
      const args = JSON.stringify(turn.tool.args);
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: turn.tool.name, arguments: '' } }] } }] })}\n\n`);
      for (let i = 0; i < args.length; i += 60) {
        events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 60) } }] } }] })}\n\n`);
      }
    }
  }
  events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  events.push('data: [DONE]\n\n');
  return events.join('');
}

let call = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const isSafety = body.stream === false;
    captured.push({ kind: isSafety ? 'safety' : 'chat', model: body.model, body });

    if (isSafety) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'User Safety: safe' } }] }));
      return;
    }

    call += 1;
    res.setHeader('Content-Type', 'text/event-stream');
    if (call === 1) {
      res.end(sse([{
        tool: {
          name: 'create_canvas',
          args: {
            title: "Contrat de bail à usage d'habitation",
            contract_type: 'bail-habitation',
            markdown: CONTRACT,
          },
        },
      }]));
    } else {
      res.end(sse([{ text: 'Je modifie le préavis.' }]));
    }
  });
});

await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
const port = (server.address() as { port: number }).port;

/* --- application ----------------------------------------------------- */

const config = loadConfig({
  OPENROUTER_API_KEY: 'local-dump',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
  LOG_LEVEL: 'error',
  SAFETY_CHECK: '1',
});

const client = createOpenRouterClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
const app = createApp({
  config,
  logger: createLogger('error'),
  templates: TemplateStore.load(),
  client,
});

async function chat(messages: unknown[], document: unknown): Promise<void> {
  const res = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, document, contract_type: 'bail-habitation' }),
  });
  await res.text();
}

/* Question 1 : création. */
await chat([
  { role: 'user', content: 'Je veux un bail d habitation pour un studio a Yopougon (Abidjan), loyer 70 000 FCFA par mois, duree 12 mois. Le bailleur est Monsieur Kone et la locataire est Madame Aya.' },
], null);

/* Question 2 : modification, avec l'historique et le document. */
await chat([
  { role: 'user', content: 'Je veux un bail d habitation pour un studio a Yopougon (Abidjan), loyer 70 000 FCFA par mois, duree 12 mois. Le bailleur est Monsieur Kone et la locataire est Madame Aya.' },
  { role: 'assistant', content: 'Le bail est prêt. Il reste 1 champ à compléter.' },
  { role: 'user', content: 'Change le préavis de deux mois à trois mois.' },
], { markdown: CONTRACT, version: 1 });

server.close();

/* --- écriture des livrables ----------------------------------------- */

const chats = captured.filter((item) => item.kind === 'chat');
const safety = captured.find((item) => item.kind === 'safety');
mkdirSync(OUT_DIR, { recursive: true });

/*
 * Les appels capturés, dans l'ordre :
 *   0 — 1re question, 1er appel (avant tout outil)
 *   1 — 1re question, 2e appel (le modèle reçoit le résultat de l'outil)
 *   2 — 2e question, 1er appel (historique + document courant)
 */
writeFileSync(
  resolve(OUT_DIR, '1-premiere-question.json'),
  JSON.stringify(chats[0]?.body ?? {}, null, 2),
  'utf8',
);
writeFileSync(
  resolve(OUT_DIR, '1b-premiere-question-apres-outil.json'),
  JSON.stringify(chats[1]?.body ?? {}, null, 2),
  'utf8',
);
writeFileSync(
  resolve(OUT_DIR, '2-deuxieme-question.json'),
  JSON.stringify(chats[2]?.body ?? {}, null, 2),
  'utf8',
);
writeFileSync(
  resolve(OUT_DIR, '3-appel-garde-fou-securite.json'),
  JSON.stringify(safety?.body ?? {}, null, 2),
  'utf8',
);

console.log('Contexte capturé :', captured.length, 'appels');
for (const name of [
  '1-premiere-question.json',
  '1b-premiere-question-apres-outil.json',
  '2-deuxieme-question.json',
  '3-appel-garde-fou-securite.json',
]) {
  console.log('  →', resolve(OUT_DIR, name));
}
