import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const ENTRY = resolve(process.cwd(), 'src', 'server.ts');

/** Lance le serveur et récupère sa sortie. */
function startServer(env: NodeJS.ProcessEnv): { child: ReturnType<typeof spawn>; output: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
  let buffer = '';
  child.stdout?.on('data', (chunk) => { buffer += String(chunk); });
  child.stderr?.on('data', (chunk) => { buffer += String(chunk); });
  return { child, output: () => buffer };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

describe('C4 — démarrage du serveur', () => {
  it('annonce l’URL quand il démarre', async () => {
    const port = await freePort();
    const { child, output } = startServer({
      PORT: String(port),
      OPENROUTER_API_KEY: 'test-key',
      LOG_LEVEL: 'error',
    });

    try {
      await new Promise((r) => setTimeout(r, 6000));
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(output()).toContain(`http://localhost:${port}`);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('explique clairement quand le port est déjà utilisé', async () => {
    const port = await freePort();
    const blocker = createServer();
    // Sur toutes les interfaces : c'est ainsi que le serveur s'attache (0.0.0.0).
    await new Promise<void>((r) => blocker.listen(port, '0.0.0.0', () => r()));

    const { child, output } = startServer({
      PORT: String(port),
      OPENROUTER_API_KEY: 'test-key',
      LOG_LEVEL: 'error',
    });

    try {
      await new Promise((r) => setTimeout(r, 6000));
      expect(output()).toContain('déjà utilisé');
      expect(output()).toContain('PORT');
    } finally {
      child.kill();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }, 30_000);
});
