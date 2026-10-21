import type { Env } from 'hono';

export type Variables = {
  requestId: string;
  clientIp: string;
  startedAt: number;
  /**
   * Identité de l'appelant, si le mécanisme d'authentification la fournit.
   * Sert de clé de quota : une identité = un quota.
   */
  identity: string | null;
};

export type AppEnv = Env & { Variables: Variables };
