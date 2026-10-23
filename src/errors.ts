/**
 * Error model shared by every route, before and after the SSE stream opens.
 * Messages are user-facing and always in French; technical details stay in the logs.
 */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'payload_too_large'
  | 'rate_limited'
  | 'storage_unavailable'
  | 'llm_unavailable'
  | 'llm_error'
  | 'truncated'
  | 'timeout'
  | 'internal';

/**
 * Statuts HTTP associés aux codes d'erreur.
 *
 * `truncated` et `timeout` n'apparaissent qu'**après** l'ouverture du flux
 * SSE : ils sont émis en événement `error` (API-CONTRACT.md §4), jamais en
 * réponse HTTP. Les statuts ci-dessous ne servent que de repli si un de ces
 * codes était un jour levé par une route ; ils ne correspondent à aucun
 * statut prévu par le contrat.
 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  storage_unavailable: 503,
  llm_unavailable: 503,
  llm_error: 502,
  truncated: 400,
  timeout: 504,
  internal: 500,
};

const RETRYABLE: Record<ErrorCode, boolean> = {
  bad_request: false,
  unauthorized: false,
  not_found: false,
  payload_too_large: false,
  rate_limited: true,
  storage_unavailable: true,
  llm_unavailable: true,
  llm_error: true,
  truncated: true,
  timeout: true,
  internal: false,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  bad_request: "La demande n'a pas pu être traitée. Reformulez ou rechargez la page.",
  unauthorized: 'Authentification requise ou invalide.',
  not_found: 'Ressource introuvable.',
  payload_too_large: 'Le document ou le message est trop long.',
  rate_limited: 'Trop de demandes. Réessayez dans quelques instants.',
  storage_unavailable: 'Le stockage des historiques est momentanément indisponible. Réessayez.',
  llm_unavailable: 'Le service de rédaction est momentanément indisponible. Réessayez.',
  llm_error: 'La rédaction n’a pas pu aboutir. Réessayez ou simplifiez votre demande.',
  truncated:
    'Le contrat est trop long pour être généré d’un seul coup. Réessayez ou demandez-le en plusieurs parties.',
  timeout: 'La génération a pris trop de temps. Réessayez.',
  internal: 'Une erreur est survenue. Réessayez.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly userMessage: string;
  /** Technical detail, for logs only — never sent to the client. */
  readonly detail?: string;

  constructor(code: ErrorCode, userMessage?: string, detail?: string) {
    super(userMessage ?? DEFAULT_MESSAGE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE[code];
    this.userMessage = userMessage ?? DEFAULT_MESSAGE[code];
    this.detail = detail;
  }
}

export function errorBody(code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
