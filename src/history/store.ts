/**
 * Contract histories: storage contract shared by the routes, the Firestore
 * adapter and the test fake.
 *
 * A history belongs to exactly one Firebase user (`uid`). The store never
 * exposes another user's documents: every method takes the uid from the
 * verified token.
 */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface HistorySummary {
  id: string;
  title: string;
  contract_type: string | null;
  version: number;
  /** ISO 8601, UTC. */
  created_at: string;
  /** ISO 8601, UTC. */
  updated_at: string;
}

export interface HistoryRecord extends HistorySummary {
  markdown: string;
  messages: HistoryMessage[];
}

export interface HistoryInput {
  title: string;
  contract_type: string | null;
  markdown: string;
  version: number;
  messages: HistoryMessage[];
}

export interface HistoryStore {
  /** Les plus récents d'abord ; les documents expirés sont ignorés. */
  list(uid: string, limit: number): Promise<HistorySummary[]>;
  /** `null` si absent, expiré, ou appartenant à un autre utilisateur. */
  get(uid: string, id: string): Promise<HistoryRecord | null>;
  /** Crée ou remplace le document ; renvoie l'enregistrement écrit. */
  put(uid: string, id: string, input: HistoryInput): Promise<HistoryRecord>;
  /** Idempotent : supprimer un document absent ne lève pas d'erreur. */
  delete(uid: string, id: string): Promise<void>;
}
