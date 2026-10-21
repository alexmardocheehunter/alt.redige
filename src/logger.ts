/**
 * Structured logger.
 * Contract rule: never log contract content or user messages — only metadata.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values must never reach the logs. */
const FORBIDDEN_KEYS = new Set([
  'content',
  'markdown',
  'document',
  'messages',
  'prompt',
  'system',
  'new_str',
  'old_str',
  'text',
  'body',
  'user',
  'assistant',
  // Réponses brutes d'un fournisseur : elles peuvent reprendre un extrait de
  // la demande de l'utilisateur ou du contrat.
  'answer',
  'provider_message',
  'raw_answer',
]);

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrub(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = scrub(item, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function createLogger(level: LogLevel = 'info', base: LogFields = {}): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const emit = (msgLevel: LogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[msgLevel] < threshold) return;
    const payload = {
      ts: new Date().toISOString(),
      level: msgLevel,
      msg: message,
      ...(scrub(base) as LogFields),
      ...(fields ? (scrub(fields) as LogFields) : {}),
    };
    const line = JSON.stringify(payload);
    if (msgLevel === 'error') console.error(line);
    else if (msgLevel === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
