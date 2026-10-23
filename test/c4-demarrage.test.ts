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

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Attend qu'une condition devienne vraie (démarrage tsx plus lent en parallèle). */
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // le serveur n'écoute pas encore
    }
    await sleep(250);
  }
  return false;
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
      const ready = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status !== 200) return false;
        const body = await res.json() as { ok: boolean };
        return body.ok === true;
      });
      expect(ready).toBe(true);
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
      const explained = await waitFor(() => output().includes('déjà utilisé'));
      expect(explained).toBe(true);
      expect(output()).toContain('PORT');
    } finally {
      child.kill();
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  }, 30_000);
});
