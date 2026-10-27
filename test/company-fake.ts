/**
 * In-memory CompanyProfileStore for route/tool tests.
 *
 * It intentionally mirrors the default-profile rules of the Firestore adapter:
 * every account keeps one default, five profiles maximum, and deleting the
 * default promotes the most recently updated remaining profile.
 */
import {
  CompanyProfileLimitError,
  MAX_COMPANY_PROFILES,
  emptyCompanyProfileFields,
  type CompanyProfile,
  type CompanyProfileInput,
  type CompanyProfileStore,
} from '../src/company/store.js';

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryCompanyProfileStore implements CompanyProfileStore {
  private readonly docs = new Map<string, Map<string, CompanyProfile>>();
  /** Operations that must throw, to exercise storage_unavailable. */
  readonly failures = new Set<string>();
  private clock = 0;

  private now(): string {
    this.clock += 1;
    return new Date(BASE_TIME + this.clock * 1000).toISOString();
  }

  private userDocs(uid: string): Map<string, CompanyProfile> {
    let docs = this.docs.get(uid);
    if (!docs) {
      docs = new Map();
      this.docs.set(uid, docs);
    }
    return docs;
  }

  private ensureOperation(operation: string): void {
    if (this.failures.has(operation)) throw new Error(`memory_store_failed:${operation}`);
  }

  async list(uid: string): Promise<CompanyProfile[]> {
    this.ensureOperation('list');
    return [...this.userDocs(uid).values()]
      .sort((a, b) => {
        if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
        return b.updated_at.localeCompare(a.updated_at);
      })
      .map(clone);
  }

  async get(uid: string, id: string): Promise<CompanyProfile | null> {
    this.ensureOperation('get');
    const profile = this.userDocs(uid).get(id);
    return profile ? clone(profile) : null;
  }

  async getDefault(uid: string): Promise<CompanyProfile | null> {
    this.ensureOperation('getDefault');
    const profiles = [...this.userDocs(uid).values()];
    return clone(
      profiles.find((profile) => profile.is_default)
      ?? profiles.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
      ?? null,
    );
  }

  async put(uid: string, id: string, input: CompanyProfileInput): Promise<CompanyProfile> {
    this.ensureOperation('put');
    const docs = this.userDocs(uid);
    const existing = docs.get(id);
    if (!existing && docs.size >= MAX_COMPANY_PROFILES) {
      throw new CompanyProfileLimitError();
    }

    const hasOtherDefault = [...docs.values()].some(
      (profile) => profile.id !== id && profile.is_default,
    );
    let isDefault = input.is_default === true;
    if (!isDefault) {
      if (!hasOtherDefault) isDefault = true;
      else if (existing?.is_default && input.is_default !== false) isDefault = true;
    }

    const timestamp = this.now();
    const fields = { ...emptyCompanyProfileFields() };
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      const value = input[key];
      if (typeof value === 'string') fields[key] = value;
    }
    const record: CompanyProfile = {
      id,
      ...fields,
      is_default: isDefault,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    };

    if (isDefault) {
      for (const [otherId, other] of docs) {
        if (otherId !== id) docs.set(otherId, { ...other, is_default: false });
      }
    }
    docs.set(id, record);
    return clone(record);
  }

  async delete(uid: string, id: string): Promise<void> {
    this.ensureOperation('delete');
    const docs = this.userDocs(uid);
    const existing = docs.get(id);
    docs.delete(id);
    if (!existing?.is_default) return;
    const next = [...docs.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (next) docs.set(next.id, { ...next, is_default: true });
  }

  async deleteAll(uid: string): Promise<number> {
    this.ensureOperation('deleteAll');
    const docs = this.userDocs(uid);
    const count = docs.size;
    docs.clear();
    return count;
  }
}
