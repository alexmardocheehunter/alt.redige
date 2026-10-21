import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { createOpenRouterClient } from './src/llm.js';
import { TemplateStore } from './src/templates.js';

const CONTRACT = `# Contrat de bail à usage d'habitation

Entre les soussignés :

**Monsieur Koné**, demeurant à Abidjan, ci-après désigné « le **Bailleur** »,

et

**Madame Aya**, demeurant à Abidjan, ci-après désignée « la **Locataire** »,
`;

const args = JSON.stringify({
  title: "Contrat de bail à usage d'habitation",
  contract_type: 'bail-habitation',
  markdown: CONTRACT,
});

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    res.setHeader('Content-Type', 'text/event-stream');
    if (parsed.stream !== true) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'User Safety: safe' } }] }));
      return;
    }
    const chunks: string[] = [];
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_canvas', arguments: '' } }] } }] })}\n\n`);
    for (let i = 0; i < args.length; i += 40) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 40) } }] } }] })}\n\n`);
    }
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    chunks.push('data: [DONE]\n\n');
    res.end(chunks.join(''));
  });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const config = loadConfig({ OPENROUTER_API_KEY: 'k', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/api/v1` });
const client = createOpenRouterClient({ baseUrl: config.baseUrl, apiKey: 'k' });
const app = createApp({ config, logger: createLogger('error'), templates: TemplateStore.load(), client });

const res = await app.request('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Je veux un bail.' }] }),
});

const text = await res.text();
const streamed = text.split(/\n\n/)
  .filter((b) => b.includes('event: canvas_delta'))
  .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(5)).text)
  .join('');

console.log('longueur streamed :', streamed.length, '— longueur CONTRACT :', CONTRACT.length);
console.log('identique :', streamed === CONTRACT);
for (let i = 0; i < Math.max(streamed.length, CONTRACT.length); i++) {
  if (streamed[i] !== CONTRACT[i]) {
    console.log(`ecart a l'index ${i} :`);
    console.log('  streamed :', JSON.stringify(streamed.slice(Math.max(0, i - 50), i + 50)));
    console.log('  CONTRACT :', JSON.stringify(CONTRACT.slice(Math.max(0, i - 50), i + 50)));
    break;
  }
}
server.close();
