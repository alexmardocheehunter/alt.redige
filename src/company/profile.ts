/**
 * Validation and presentation helpers for company profiles.
 *
 * The routes and the chat tools share them so that the limits and the
 * confirmation guard cannot drift apart. No legal interpretation is performed:
 * values are copied as entered by the user.
 */
import type { CompanyProfile, CompanyProfileFields, CompanyProfileInput } from './store.js';
import {
  COMPANY_FIELD_KEYS,
  COMPANY_FIELD_LIMITS,
  MAX_COMPANY_LOGO_LENGTH,
  emptyCompanyProfileFields,
  type CompanyFieldKey,
} from './store.js';

export const COMPANY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LOGO_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export class CompanyProfileValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_request' | 'payload_too_large' = 'bad_request',
  ) {
    super(message);
    this.name = 'CompanyProfileValidationError';
  }
}

export function isValidCompanyId(value: string): boolean {
  return COMPANY_ID_RE.test(value);
}

/** Une valeur non vide, hors espaces. */
export function profileHasContent(fields: CompanyProfileFields): boolean {
  return COMPANY_FIELD_KEYS.some((key) => fields[key].trim().length > 0);
}

/** Vrai si l'image est une data URL des formats autorisés, ou une chaîne vide. */
export function isValidLogo(value: string): boolean {
  if (value.length === 0) return true;
  return value.length <= MAX_COMPANY_LOGO_LENGTH && LOGO_RE.test(value);
}

function readString(
  key: CompanyFieldKey,
  value: unknown,
): string {
  if (typeof value !== 'string') {
    throw new CompanyProfileValidationError('Champ de profil invalide.');
  }
  const trimmed = value.trim();
  if (trimmed.length > COMPANY_FIELD_LIMITS[key]) {
    throw new CompanyProfileValidationError(
      key === 'logo'
        ? 'Le logo est trop volumineux (120 000 caractères maximum).'
        : `Le champ « ${key} » est trop long (${COMPANY_FIELD_LIMITS[key]} caractères maximum).`,
      'payload_too_large',
    );
  }
  if (key === 'logo' && !isValidLogo(trimmed)) {
    throw new CompanyProfileValidationError(
      'Le logo doit être une image PNG, JPEG, WEBP ou GIF encodée en data URL.',
    );
  }
  return trimmed;
}

/**
 * Lit un corps de profil.
 *
 * `partial` est utilisé par l'outil de chat : seuls les champs présents sont
 * renvoyés, les autres sont conservés par l'appelant. Sans `partial`, un champ
 * absent vaut la chaîne vide (remplacement complet, comme le `PUT`).
 */
export function parseCompanyProfileFields(
  raw: unknown,
  options: { partial: boolean },
): { fields: Partial<CompanyProfileFields>; isDefault?: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CompanyProfileValidationError('Corps de requête invalide.');
  }
  const body = raw as Record<string, unknown>;
  const fields: Partial<CompanyProfileFields> = {};

  for (const key of COMPANY_FIELD_KEYS) {
    if (!(key in body)) {
      if (!options.partial) fields[key] = '';
      continue;
    }
    if (body[key] === null || body[key] === undefined) {
      if (!options.partial) fields[key] = '';
      continue;
    }
    fields[key] = readString(key, body[key]);
  }

  let isDefault: boolean | undefined;
  if (body.is_default !== undefined && body.is_default !== null) {
    if (typeof body.is_default !== 'boolean') {
      throw new CompanyProfileValidationError('Le marqueur de profil par défaut est invalide.');
    }
    isDefault = body.is_default;
  }

  if (!options.partial && !profileHasContent({ ...emptyCompanyProfileFields(), ...fields })) {
    throw new CompanyProfileValidationError('Renseignez au moins un champ du profil.');
  }

  return isDefault === undefined ? { fields } : { fields, isDefault };
}

/** Construit un PUT complet à partir de champs déjà validés. */
export function completeProfileInput(
  fields: Partial<CompanyProfileFields>,
  isDefault?: boolean,
): CompanyProfileInput {
  const complete = { ...emptyCompanyProfileFields(), ...fields };
  if (!profileHasContent(complete)) {
    throw new CompanyProfileValidationError('Renseignez au moins un champ du profil.');
  }
  return isDefault === undefined ? complete : { ...complete, is_default: isDefault };
}

/** Fusionne un correctif partiel avec le profil existant. */
export function mergeProfileFields(
  existing: CompanyProfile | null,
  patch: Partial<CompanyProfileFields>,
): CompanyProfileInput {
  const base = existing
    ? pickFields(existing)
    : emptyCompanyProfileFields();
  const merged = { ...base, ...patch };
  if (!profileHasContent(merged)) {
    throw new CompanyProfileValidationError('Renseignez au moins un champ du profil.');
  }
  return merged;
}

export function pickFields(profile: CompanyProfileFields): CompanyProfileFields {
  const out = emptyCompanyProfileFields();
  for (const key of COMPANY_FIELD_KEYS) out[key] = profile[key] ?? '';
  return out;
}

/** Nom lisible du profil, sans jamais inventer de raison sociale. */
export function profileDisplayLabel(profile: Pick<CompanyProfile, 'label' | 'legal_name'>): string {
  return profile.label.trim() || profile.legal_name.trim() || 'Mon entreprise';
}

/** Nom complet du représentant, ou chaîne vide. */
export function representativeFullName(
  profile: Pick<CompanyProfile, 'representative_first_name' | 'representative_last_name'>,
): string {
  return [profile.representative_first_name, profile.representative_last_name]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}

/** Adresse du siège, dans l'ordre demandé par le contrat. */
export function companyAddress(
  profile: Pick<CompanyProfile, 'address' | 'city' | 'postal_box'>,
): string {
  return [profile.address, profile.city, profile.postal_box]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

/** Texte injecté dans le prompt : des données, jamais des instructions. */
export function companyProfilePromptText(profile: CompanyProfile | null): string {
  if (!profile) {
    return '(aucun profil d’entreprise enregistré pour ce compte)';
  }
  const lines: string[] = [];
  const add = (label: string, value: string) => {
    if (value.trim()) lines.push(`${label} : ${value.trim()}`);
  };
  add('Nom du profil', profile.label || profileDisplayLabel(profile));
  add('Raison sociale', profile.legal_name);
  add('Forme juridique', profile.legal_form);
  add('Capital', profile.capital);
  add('RCCM', profile.rccm);
  add('Compte contribuable', profile.tax_id);
  add('Adresse du siège', companyAddress(profile));
  add('Représentant', representativeFullName(profile));
  add('Qualité du représentant', profile.representative_role);
  add('Téléphone', profile.phone);
  add('Courriel', profile.email);
  add('Lieu de signature', profile.signature_place);
  return lines.join('\n') || '(profil d’entreprise vide)';
}

/**
 * Garde-fou de l'outil `save_company_profile`.
 *
 * Le modèle doit envoyer `confirmed: true` **et** le dernier message de
 * l'utilisateur doit être une confirmation courte. Une simple description
 * (« mon entreprise s'appelle… ») ne suffit jamais.
 */
export function isProfileSaveConfirmed(text: string): boolean {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 160) return false;
  if (/^(non|pas|annule|modifie|change|attends|stop)\b/.test(normalized)) return false;
  return /^(oui|ouais|yes|ok|d'accord|accord|je confirme|confirme|c'est exact|cest exact|exact|enregistre|sauvegarde|valide|vas-y|allez-y|bien sur)\b/.test(normalized);
}
