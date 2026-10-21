import { buildSystemPrompt } from './src/agent/prompt.js';
import { toolDefinitions } from './src/agent/tools.js';
import { TemplateStore } from './src/templates.js';
import { createOpenRouterClient } from './src/llm.js';

const templates = TemplateStore.load();
const system = buildSystemPrompt(templates);
const tools = toolDefinitions(templates);

const client = createOpenRouterClient({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const body = {
  model: 'minimax/minimax-m3.1-flash:free',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: '<document_courant>(aucun document)</document_courant>\n\nJe veux un bail d habitation pour un studio a Yopougon (Abidjan), loyer 70 000 FCFA par mois, duree 12 mois.' },
  ],
  tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  stream: true,
  max_tokens: 16000,
  usage: { include: true },
};

const t0 = Date.now();
const res = await client.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: client.headers,
  body: JSON.stringify(body),
});

console.log(`en-tetes recus en ${Date.now() - t0} ms — status ${res.status}`);

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let first = true;
let chunks = 0;
let bytes = 0;

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  bytes += value.byteLength;
  chunks += 1;
  if (first) {
    first = false;
    console.log(`premier chunk a ${Date.now() - t0} ms (${value.byteLength} octets)`);
  }
}

console.log(`fin du flux a ${Date.now() - t0} ms — ${chunks} chunks, ${bytes} octets`);
