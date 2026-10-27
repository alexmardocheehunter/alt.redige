/**
 * Firestore adapter for company profiles.
 *
 * Layout:
 *   users/{uid}/companies/{profileId}
 *
 * Client access is denied by `firestore.rules`; only the Admin SDK (server)
 * reads and writes. The adapter never accepts a uid from the request body:
 * the routes pass the Firebase identity.
 */
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  COMPANY_FIELD_KEYS,
  CompanyProfileLimitError,
  emptyCompanyProfileFields,
  MAX_COMPANY_PROFILES,
  type CompanyProfile,
  type CompanyProfileInput,
  type CompanyProfileStore,
} from './store.js';

function asTimestamp(value: unknown): Timestamp | null {
  return value instanceof Timestamp ? value : null;
}

function iso(value: unknown): string {
  const timestamp = asTimestamp(value);
  return timestamp ? timestamp.toDate().toISOString() : new Date(0).toISOString();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class FirestoreCompanyProfileStore implements CompanyProfileStore {
  constructor(private readonly db: Firestore) {}

  private collection(uid: string) {
    return this.db.collection('users').doc(uid).collection('companies');
  }

  private record(id: string, data: Record<string, unknown>): CompanyProfile {
    const fields = emptyCompanyProfileFields();
    for (const key of COMPANY_FIELD_KEYS) fields[key] = asString(data[key]);
    return {
      id,
      ...fields,
      is_default: data.is_default === true,
      created_at: iso(data.created_at),
      updated_at: iso(data.updated_at),
    };
  }

  async list(uid: string): Promise<CompanyProfile[]> {
    const snapshot = await this.collection(uid)
      .orderBy('updated_at', 'desc')
      .limit(MAX_COMPANY_PROFILES)
      .get();
    return snapshot.docs
      .map((doc) => this.record(doc.id, doc.data() ?? {}))
      .sort((a, b) => {
        if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      });
  }

  async get(uid: string, id: string): Promise<CompanyProfile | null> {
    const doc = await this.collection(uid).doc(id).get();
    if (!doc.exists) return null;
    return this.record(doc.id, doc.data() ?? {});
  }

  async getDefault(uid: string): Promise<CompanyProfile | null> {
    const snapshot = await this.collection(uid)
      .where('is_default', '==', true)
      .limit(1)
      .get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0]!;
      return this.record(doc.id, doc.data() ?? {});
    }
    const all = await this.list(uid);
    return all[0] ?? null;
  }

  async put(uid: string, id: string, input: CompanyProfileInput): Promise<CompanyProfile> {
    const collection = this.collection(uid);
    const ref = collection.doc(id);
    const all = await collection.get();
    const existingDoc = all.docs.find((doc) => doc.id === id);
    if (!existingDoc && all.size >= MAX_COMPANY_PROFILES) {
      throw new CompanyProfileLimitError();
    }

    const hasOtherDefault = all.docs.some(
      (doc) => doc.id !== id && doc.get('is_default') === true,
    );
    let isDefault = input.is_default === true;
    if (!isDefault) {
      // Un compte garde toujours un profil par défaut.
      if (!hasOtherDefault) isDefault = true;
      else if (existingDoc?.get('is_default') === true && input.is_default !== false) isDefault = true;
    }

    const now = Timestamp.now();
    const previousCreatedAt = asTimestamp(existingDoc?.get('created_at'));
    const createdAt = previousCreatedAt ?? now;
    const data = {
      ...emptyCompanyProfileFields(),
      ...input,
      is_default: isDefault,
      created_at: createdAt,
      updated_at: now,
    };

    const batch = this.db.batch();
    if (isDefault) {
      for (const doc of all.docs) {
        if (doc.id !== id && doc.get('is_default') === true) {
          batch.update(doc.ref, { is_default: false });
        }
      }
    }
    batch.set(ref, data);
    await batch.commit();
    return this.record(id, data);
  }

  async delete(uid: string, id: string): Promise<void> {
    const collection = this.collection(uid);
    const ref = collection.doc(id);
    const existing = await ref.get();
    if (!existing.exists) return;

    const wasDefault = existing.get('is_default') === true;
    await ref.delete();
    if (!wasDefault) return;

    const remaining = await collection.orderBy('updated_at', 'desc').limit(1).get();
    const next = remaining.docs[0];
    if (next) await next.ref.update({ is_default: true });
  }

  async deleteAll(uid: string): Promise<number> {
    const snapshot = await this.collection(uid).get();
    if (snapshot.empty) return 0;
    const batch = this.db.batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
    return snapshot.size;
  }
}
