const KEY = process.env.OPENROUTER_API_KEY;
const URL = 'https://openrouter.ai/api/v1/chat/completions';

async function post(label: string, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: payload,
    });
    await res.text();
    console.log(`  ${label.padEnd(28)} ${String(payload.length).padStart(6)} o  status ${res.status}  ${Date.now() - t0} ms`);
  } catch (e: any) {
    console.log(`  ${label.padEnd(28)} ${String(payload.length).padStart(6)} o  ECHEC ${e.cause?.code ?? e.message}  ${Date.now() - t0} ms`);
  }
}

for (const size of [200, 1000, 2000, 3000, 4000, 5000, 6000, 8000]) {
  await post(`corps ~${size} o`, {
    model: 'minimax/minimax-m3.1-flash:free',
    messages: [{ role: 'user', content: 'x'.repeat(size) }],
    max_tokens: 8,
    stream: false,
  });
}
