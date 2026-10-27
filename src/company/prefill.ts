/**
 * Deterministic employer-side prefill.
 *
 * The LLM writes the contract; it never receives the authority to invent the
 * employer's identity. Once the document is produced, this function replaces
 * only the placeholders whose text explicitly designates the employer. The
 * counterparty's placeholders are left untouched and remain counted.
 *
 * Prefill is limited to contracts where the user's company is the employer
 * side. A bail or a service contract can put the company on either side, so
 * those documents are left unchanged.
 */
import type { CompanyProfile } from './store.js';
import { companyAddress, representativeFullName } from './profile.js';

export const EMPLOYER_CONTRACT_TYPES = new Set([
  'apprentissage',
  'cdd-terme-imprecis',
  'cdd-terme-precis',
  'cdi',
  'stage-ecole',
  'stage-qualification',
  'teletravail',
]);

// Map of contract type to the employer profile fields that should be prefilled
// This defines which profile fields are relevant for each contract type
export const EMPLOYER_PROFILE_FIELDS_BY_CONTRACT: Record<string, string[]> = {
  'cdi': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
  'cdd-terme-precis': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
  'cdd-terme-imprecis': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
  'apprentissage': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
  'stage-ecole': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
  'stage-qualification': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
  'teletravail': [
    'legal_name', 'legal_form', 'capital', 'rccm', 'tax_id',
    'address', 'city', 'postal_box',
    'representative_first_name', 'representative_last_name', 'representative_role',
    'phone', 'email', 'signature_place'
  ],
};

const PLACEHOLDER_RE = /\[À COMPLÉTER\s*:\s*([^\]]+)\]/g;
const COUNTERPARTY_TERMS = [
  'salarie',
  'employe',
  'apprenti',
  'apprentissage',
  'stagiaire',
  'etudiant',
  'teletravailleur',
  'bailleur',
  'preneur',
  'locataire',
  'prestataire',
  'autorite contractante',
  'etablissement',
  'local',
  'logement',
];

export interface PrefillResult {
  markdown: string;
  /** Nombre d'espaces réservés effectivement remplacés. */
  filled: number;
  /** Nombre d'espaces réservés restants. */
  remaining: number;
}

/**
 * Returns the list of employer profile fields that should be prefilled
 * for a given contract type. Returns empty array for non-employer contracts.
 */
export function getEmployerProfileFieldsForContract(contractType: string | null): string[] {
  if (!contractType) return [];
  return EMPLOYER_PROFILE_FIELDS_BY_CONTRACT[contractType] ?? [];
}

function normalizeLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEmployerSideLabel(label: string): boolean {
  const normalized = normalizeLabel(label);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  if (COUNTERPARTY_TERMS.some((term) => padded.includes(` ${term} `))) return false;
  return normalized.includes('employeur')
    || normalized.includes('entreprise d accueil')
    || normalized.includes('entreprise')
    || normalized === 'adresse du siege'
    || normalized === 'siege social'
    || normalized.includes('forme juridique')
    || normalized.includes('capital')
    || normalized.includes('rccm')
    || normalized.includes('compte contribuable')
    || normalized.includes('identifiant fiscal')
    || normalized.includes('numero fiscal')
    || normalized.includes('telephone')
    || normalized.includes('courriel')
    || normalized.includes('email')
    || normalized.includes('e mail')
    || normalized === 'nom et qualite du representant'
    || normalized === 'qualite du representant'
    || normalized === 'nom du representant'
    || normalized === 'lieu'
    || normalized.includes('lieu de signature');
}

/** Valeur à substituer pour un libellé, ou `null` si le libellé n'est pas couvert. */
export function companyValueForPlaceholder(
  label: string,
  profile: CompanyProfile,
): string | null {
  if (!isEmployerSideLabel(label)) return null;
  const normalized = normalizeLabel(label);
  const legalName = cleanValue(profile.legal_name);
  const address = cleanValue(companyAddress(profile));
  const fullName = cleanValue(representativeFullName(profile));
  const role = cleanValue(profile.representative_role);

  // Nom et qualité, avant les règles « nom » et « qualité » séparées.
  if (normalized.includes('nom') && normalized.includes('qualite') && normalized.includes('representant')) {
    const parts = [fullName, role].filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  if (normalized.includes('qualite') && normalized.includes('representant')) {
    return role || null;
  }
  if (
    (normalized.includes('nom') && normalized.includes('representant'))
    || normalized.includes('prenom du representant')
  ) {
    return fullName || null;
  }
  if (normalized.includes('raison sociale') || normalized.includes('denomination sociale')) {
    return legalName || null;
  }
  if (normalized.includes('forme juridique')) {
    return cleanValue(profile.legal_form) || null;
  }
  if (normalized.includes('capital')) {
    return cleanValue(profile.capital) || null;
  }
  if (normalized.includes('rccm') || normalized.includes('registre du commerce')) {
    return cleanValue(profile.rccm) || null;
  }
  if (
    normalized.includes('compte contribuable')
    || normalized.includes('identifiant fiscal')
    || normalized.includes('numero fiscal')
  ) {
    return cleanValue(profile.tax_id) || null;
  }
  if (
    normalized.includes('adresse du siege')
    || normalized.includes('adresse de l employeur')
    || normalized.includes('adresse de l entreprise')
    || normalized.includes('siege social')
  ) {
    return address || null;
  }
  if (normalized.includes('telephone')) {
    return cleanValue(profile.phone) || null;
  }
  if (normalized.includes('courriel') || normalized.includes('email') || normalized.includes('e mail')) {
    return cleanValue(profile.email) || null;
  }
  if (normalized === 'lieu' || normalized.includes('lieu de signature') || normalized.includes('fait a')) {
    return cleanValue(profile.signature_place) || null;
  }
  return null;
}

/**
 * Remplace les espaces réservés employeur d'un contrat employeur.
 * `contractType` inconnu ou hors périmètre : aucun remplacement.
 */
export function applyCompanyProfilePrefill(
  markdown: string,
  profile: CompanyProfile | null,
  contractType: string | null,
): PrefillResult {
  const remaining = () => (markdown.match(PLACEHOLDER_RE) ?? []).length;
  if (!profile || !contractType || !EMPLOYER_CONTRACT_TYPES.has(contractType)) {
    return { markdown, filled: 0, remaining: remaining() };
  }

  let filled = 0;
  const prefilled = markdown.replace(PLACEHOLDER_RE, (token, label: string) => {
    const value = companyValueForPlaceholder(label, profile);
    if (!value) return token;
    filled += 1;
    return value;
  });
  return {
    markdown: prefilled,
    filled,
    remaining: (prefilled.match(PLACEHOLDER_RE) ?? []).length,
  };
}
