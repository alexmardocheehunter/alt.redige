import type { Env } from 'hono';

export type Variables = {
  requestId: string;
  clientIp: string;
  startedAt: number;
};

export type AppEnv = Env & { Variables: Variables };
