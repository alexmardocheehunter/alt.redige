/**
 * Company profiles: storage contract shared by the routes, the Firestore
 * adapter, the agent tools and the test fake.
 *
 * A profile belongs to exactly one Firebase user (`uid`). Every method takes
 * the uid from the verified token; the store never exposes another user's
 * documents.
 */
export const MAX_COMPANY_PROFILES = 5;
export const MAX_COMPANY_LOGO_LENGTH = 120_000;

export interface CompanyProfileFields {
  /** Nom affiché dans le sélecteur. */
  label: string;
  legal_name: string;
  legal_form: string;
  capital: string;
  rccm: string;
  tax_id: string;
  address: string;
  city: string;
  postal_box: string;
  representative_first_name: string;
  representative_last_name: string;
  representative_role: string;
  phone: string;
  email: string;
  signature_place: string;
  /** Data URL d'image, ou chaîne vide. */
  logo: string;
}

export interface CompanyProfile extends CompanyProfileFields {
  id: string;
  is_default: boolean;
  /** ISO 8601, UTC. */
  created_at: string;
  /** ISO 8601, UTC. */
  updated_at: string;
}

export interface CompanyProfileInput extends CompanyProfileFields {
  is_default?: boolean;
}

/** Levée quand un utilisateur dépasse le nombre de profils autorisé. */
export class CompanyProfileLimitError extends Error {
  constructor() {
    super('company_profile_limit');
    this.name = 'CompanyProfileLimitError';
  }
}

export interface CompanyProfileStore {
  /** Profil par défaut d'abord, puis les plus récemment modifiés. */
  list(uid: string): Promise<CompanyProfile[]>;
  /** `null` si absent ou appartenant à un autre utilisateur. */
  get(uid: string, id: string): Promise<CompanyProfile | null>;
  /** Profil marqué par défaut, sinon le plus récemment modifié. */
  getDefault(uid: string): Promise<CompanyProfile | null>;
  /**
   * Crée ou remplace un profil. Le store garantit qu'un profil reste par
   * défaut et refuse un sixième profil.
   */
  put(uid: string, id: string, input: CompanyProfileInput): Promise<CompanyProfile>;
  /** Idempotent. Si le profil supprimé était par défaut, un autre le devient. */
  delete(uid: string, id: string): Promise<void>;
  /** Supprime tous les profils de l'utilisateur. Renvoie le nombre supprimé. */
  deleteAll(uid: string): Promise<number>;
}

export const COMPANY_FIELD_KEYS = [
  'label',
  'legal_name',
  'legal_form',
  'capital',
  'rccm',
  'tax_id',
  'address',
  'city',
  'postal_box',
  'representative_first_name',
  'representative_last_name',
  'representative_role',
  'phone',
  'email',
  'signature_place',
  'logo',
] as const satisfies readonly (keyof CompanyProfileFields)[];

export type CompanyFieldKey = (typeof COMPANY_FIELD_KEYS)[number];

/** Limites de longueur, en caractères. */
export const COMPANY_FIELD_LIMITS: Record<CompanyFieldKey, number> = {
  label: 80,
  legal_name: 200,
  legal_form: 80,
  capital: 80,
  rccm: 80,
  tax_id: 80,
  address: 300,
  city: 100,
  postal_box: 100,
  representative_first_name: 100,
  representative_last_name: 100,
  representative_role: 120,
  phone: 50,
  email: 200,
  signature_place: 120,
  logo: MAX_COMPANY_LOGO_LENGTH,
};

export function emptyCompanyProfileFields(): CompanyProfileFields {
  return {
    label: '',
    legal_name: '',
    legal_form: '',
    capital: '',
    rccm: '',
    tax_id: '',
    address: '',
    city: '',
    postal_box: '',
    representative_first_name: '',
    representative_last_name: '',
    representative_role: '',
    phone: '',
    email: '',
    signature_place: '',
    logo: '',
  };
}
