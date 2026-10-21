import { checkTextSafety } from './src/safety.js';
import { createOpenRouterClient } from './src/llm.js';

const client = createOpenRouterClient({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const text = 'Je veux un bail d habitation pour un studio a Yopougon (Abidjan), loyer 70 000 FCFA par mois.';

for (const budget of [512, 1024, 2048]) {
  const results: string[] = [];
  for (let i = 0; i < 4; i++) {
    const verdict = await checkTextSafety({
      client,
      model: 'nvidia/nemotron-3.5-content-safety:free',
      text,
      signal: new AbortController().signal,
      maxTokens: budget,
    });
    results.push(`${verdict.label}${verdict.available ? '' : '(indispo)'}`);
  }
  console.log(`budget ${String(budget).padStart(4)} : ${results.join(', ')}`);
}
