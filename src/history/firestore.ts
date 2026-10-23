/**
 * Firestore adapter for contract histories.
 *
 * Layout:
 *   users/{uid}/histories/{historyId}
 *
 * Client access is denied by `firestore.rules`; only the Admin SDK (server)
 * reads and writes. Each write refreshes `expires_at`. Firestore TTL deletes
 * those documents when the Blaze plan enables it; on Spark, the scheduled
 * `npm run purge-history` script and the read-time filter below enforce the
 * same retention.
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type {
  HistoryInput,
  HistoryMessage,
  HistoryRecord,
  HistoryStore,
  HistorySummary,
} from './store.js';

export interface FirestoreHistoryOptions {
  retentionDays: number;
  maxPerUser: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function asTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null;
}

function iso(value: unknown): string {
  const timestamp = asTimestamp(value);
  return timestamp ? timestamp.toDate().toISOString() : new Date(0).toISOString();
}

function isMessage(value: unknown): value is HistoryMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { role?: unknown; content?: unknown };
  return (candidate.role === 'user' || candidate.role === 'assistant')
    && typeof candidate.content === 'string';
}

function messagesOf(value: unknown): HistoryMessage[] {
  return Array.isArray(value) ? value.filter(isMessage) : [];
}

export class FirestoreHistoryStore implements HistoryStore {
  constructor(
    private readonly db: Firestore,
    private readonly options: FirestoreHistoryOptions,
  ) {}

  private collection(uid: string) {
    return this.db.collection('users').doc(uid).collection('histories');
  }

  private isExpired(value: unknown, now = Date.now()): boolean {
    const expiresAt = asTimestamp(value);
    return expiresAt !== null && expiresAt.toMillis() <= now;
  }

  private summary(id: string, data: Record<string, unknown>): HistorySummary {
    return {
      id,
      title: typeof data.title === 'string' ? data.title : '',
      contract_type: typeof data.contract_type === 'string' ? data.contract_type : null,
      version: typeof data.version === 'number' ? data.version : 1,
      created_at: iso(data.created_at),
      updated_at: iso(data.updated_at),
    };
  }

  private record(id: string, data: Record<string, unknown>): HistoryRecord {
    return {
      ...this.summary(id, data),
      markdown: typeof data.markdown === 'string' ? data.markdown : '',
      messages: messagesOf(data.messages),
    };
  }

  async list(uid: string, limit: number): Promise<HistorySummary[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    // The store caps each user at `maxPerUser` documents, so reading that many
    // summaries guarantees that expired documents at the top cannot hide valid
    // ones. The field mask avoids transferring markdown and messages.
    const snapshot = await this.collection(uid)
      .select('title', 'contract_type', 'version', 'created_at', 'updated_at', 'expires_at')
      .orderBy('updated_at', 'desc')
      .limit(this.options.maxPerUser)
      .get();
    const now = Date.now();
    const expired = snapshot.docs.filter((doc) => this.isExpired(doc.get('expires_at'), now));
    if (expired.length > 0) {
      // Purge opportuniste : les documents expirés ne doivent ni apparaître ni
      // rester si le TTL n'est pas actif (offre Spark, TTL en attente).
      const batch = this.db.batch();
      for (const doc of expired) batch.delete(doc.ref);
      await batch.commit().catch(() => undefined);
    }
    const expiredIds = new Set(expired.map((doc) => doc.id));
    return snapshot.docs
      .filter((doc) => !expiredIds.has(doc.id))
      .slice(0, safeLimit)
      .map((doc) => this.summary(doc.id, doc.data() ?? {}));
  }

  async get(uid: string, id: string): Promise<HistoryRecord | null> {
    const doc = await this.collection(uid).doc(id).get();
    if (!doc.exists) return null;
    const data = doc.data() ?? {};
    if (this.isExpired(data.expires_at)) {
      // Le TTL peut mettre jusqu'à 24 h à supprimer un document. On le cache
      // immédiatement et on tente la suppression sans faire échouer la lecture.
      await doc.ref.delete().catch(() => undefined);
      return null;
    }
    return this.record(doc.id, data);
  }

  async put(uid: string, id: string, input: HistoryInput): Promise<HistoryRecord> {
    const collection = this.collection(uid);
    const ref = collection.doc(id);
    // Only metadata is needed; avoid transferring a potentially large markdown.
    const [existing] = await this.db.getAll(ref, {
      fieldMask: ['created_at', 'expires_at'],
    });
    if (!existing) throw new Error('Firestore returned no snapshot for the history.');
    const existingExpired = existing.exists && this.isExpired(existing.get('expires_at'));
    const now = Timestamp.now();
    const previousCreatedAt = asTimestamp(existing.get('created_at'));
    const createdAt = existing.exists && !existingExpired && previousCreatedAt ? previousCreatedAt : now;

    if (!existing.exists || existingExpired) {
      await this.trim(collection);
    }

    const data = {
      title: input.title,
      contract_type: input.contract_type,
      markdown: input.markdown,
      version: input.version,
      messages: input.messages,
      created_at: createdAt,
      updated_at: now,
      expires_at: Timestamp.fromMillis(now.toMillis() + this.options.retentionDays * DAY_MS),
    };

    // Replacement, not merge: a deleted message must not survive the update.
    await ref.set(data);
    return this.record(id, data);
  }

  async delete(uid: string, id: string): Promise<void> {
    await this.collection(uid).doc(id).delete();
  }

  /**
   * Keeps at most `maxPerUser` documents. Called only before creating a new
   * one, so an update never deletes a concurrent save.
   */
  private async trim(collection: ReturnType<FirestoreHistoryStore['collection']>): Promise<void> {
    const aggregate = await collection.count().get();
    const excess = aggregate.data().count - this.options.maxPerUser + 1;
    if (excess <= 0) return;

    const oldest = await collection
      .orderBy('updated_at', 'asc')
      .limit(excess)
      .get();
    if (oldest.empty) return;

    const batch = this.db.batch();
    for (const doc of oldest.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}
