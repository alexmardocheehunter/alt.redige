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

/* --- rédaction de docs/CONTEXTE-MODELE.md ------------------------------ */

/** Les messages d'un appel, rendus en Markdown. */
function renderMessages(body: any): string {
  const messages = (body?.messages ?? []) as Array<{ role: string; content: string; tool_calls?: unknown[] }>;
  const blocks: string[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === 'system') {
      blocks.push(`### [${index}] \`system\`\n\n\`\`\`text\n${message.content}\n\`\`\``);
      continue;
    }

    if (message.role === 'tool') {
      blocks.push(`### [${index}] \`tool\`\n\n\`\`\`text\n${message.content}\n\`\`\``);
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls) {
      blocks.push(
        `### [${index}] \`assistant\`\n\n_Appels d'outils :_\n\n\`\`\`json\n`
        + JSON.stringify(message.tool_calls, null, 2)
        + '\n```',
      );
      continue;
    }

    blocks.push(`### [${index}] \`${message.role}\`\n\n\`\`\`text\n${message.content}\n\`\`\``);
  }

  return blocks.join('\n\n');
}

function renderMarkdown(): string {
  const first = chats[0]?.body ?? {};
  const afterTool = chats[1]?.body ?? {};
  const second = chats[2]?.body ?? {};

  const system = (first.messages ?? []).find((message: any) => message.role === 'system');
  const firstUser = (first.messages ?? [])[first.messages.length - 1];
  const tools = (first.tools ?? []) as Array<{ function?: { name?: string; description?: string } }>;
  const toolNames = tools.map((tool) => tool.function?.name ?? '?');

  return `# Contexte envoyé au modèle

Ce document décrit **exactement** ce que le modèle reçoit à chaque appel.
Les fichiers \`docs/contexte-modele/*.json\` sont les charges utiles capturées
sur le réseau (via un serveur local qui parle le protocole OpenRouter) : ce ne
sont pas des reconstructions.

Ce fichier est **généré** par \`scripts/dump-contexte.ts\` : il ne peut pas
dériver de la réalité.

Pour régénérer :

\`\`\`bash
npx tsx scripts/dump-contexte.ts
\`\`\`

Pour capturer le contexte d'une **session réelle**, lancer le serveur avec :

\`\`\`bash
LLM_DEBUG_DIR=tmp/contexte npm start
\`\`\`

Chaque requête sortante est alors écrite dans \`tmp/contexte/\` (dossier ignoré
par git). Ces fichiers contiennent les données de l'utilisateur : ils ne doivent
pas être versionnés.

---

## 1. Ce qui est envoyé, à chaque appel

| Élément | Origine | Taille (1re question) |
|---|---|---|
| \`system\` | \`prompts/system.fr.md\` + catalogue des modèles | ${system?.content?.length ?? 0} caractères |
| \`messages[]\` | historique du client + bloc \`<document_courant>\` | ${firstUser?.content?.length ?? 0} caractères (dernier message) |
| \`tools[]\` | \`src/agent/tools.ts\` | ${tools.length} outils |
| \`model\` | \`LLM_MODELS\` (1er de la chaîne de bascule) | \`${first.model ?? '?'}\` |
| \`max_tokens\` | \`MAX_OUTPUT_TOKENS\` | ${first.max_tokens ?? '?'} |
| \`stream\` / \`usage\` | fixes | \`${first.stream}\` / \`{include:true}\` |

### Les ${tools.length} outils

| Outil | Rôle |
|---|---|
| \`get_template\` | charge le modèle de référence (squelette, champs, notes juridiques) |
| \`create_canvas\` | écrit le contrat complet dans le Canvas |
| \`edit_canvas\` | modifie le document par remplacements ciblés \`{old_str, new_str}\` |
| \`ask_user\` | pose une question à l'utilisateur (le tour s'arrête) |
| \`explain_clause\` | explique une clause du document (contrôlé avant émission) |

Outils déclarés : ${toolNames.map((name) => `\`${name}\``).join(', ')}.

---

## 2. Première question

${renderMessages(first)}

---

## 3. Le modèle reçoit le résultat de l'outil

${renderMessages(afterTool)}

Le dernier message est le **document à jour** : après une écriture, le modèle
revoit l'état réel du contrat. Sans cela, il continuait sur l'état précédent et
rééditait la même clause.

---

## 4. Deuxième question

L'historique est renvoyé tel quel, et le **document courant** est joint au
dernier message utilisateur, encadré par \`<document_courant>\`. C'est ce bloc
qui fait foi : le modèle ne doit pas se fier à sa mémoire de la conversation.

${renderMessages(second)}

---

## 5. Le garde-fou de sécurité

Avant même l'appel de rédaction, le message de l'utilisateur passe par le
modèle de sécurité. C'est un appel **séparé**, dans un autre modèle, avec un
autre prompt.

${renderMessages(safety?.body ?? {})}

---

## 6. Ce qui n'est **pas** envoyé

- Aucun outil n'est déclaré pour le garde-fou : il ne fait que classer.
- Le prompt ne contient **jamais** de donnée du contrat ou du message de
  l'utilisateur : le squelette du modèle n'est envoyé qu'à l'intérieur du
  bloc \`<modele_contrat>\`, c'est-à-dire dans le contexte de l'outil.
- Aucune donnée n'est écrite dans les journaux du serveur
  (cf. \`src/logger.ts\` : les clés \`content\`, \`markdown\`, \`message\`,
  \`prompt\`, \`new_str\`, \`old_str\` sont remplacées par \`[redacted]\`).
`;
}

const markdownPath = resolve(process.cwd(), 'docs', 'CONTEXTE-MODELE.md');
writeFileSync(markdownPath, renderMarkdown(), 'utf8');
console.log('  →', markdownPath);
