/**
 * Champs obligatoires d'un type de contrat : ce qui manque, ce qui est renseigné.
 *
 * Deux usages, tous deux côté serveur :
 *  - P0-3 : refuser `create_canvas` quand l'utilisateur n'a fourni aucune
 *    information exploitable pour les champs obligatoires ;
 *  - P1-5 : signaler, dans `validation.issues`, chaque champ obligatoire
 *    laissé vide.
 *
 * Les détecteurs sont **génériques** : le type d'un champ est déduit de son
 * libellé, jamais d'une donnée juridique. Aucune valeur de droit n'est
 * écrite ici.
 */
import type { ContractTemplate, TemplateField } from '../templates.js';
import { normalizeKey } from './structure.js';

/** Nature attendue d'une information, déduite du libellé du champ. */
export type FieldKind = 'money' | 'duration' | 'date' | 'identity' | 'place' | 'text';

const KIND_RULES: Array<[FieldKind, RegExp]> = [
  ['money', /montant|loyer|prix|salaire|r[ée]mun[ée]ration|indemnit[ée]|caution|garantie|prime|avance|virement/i],
  ['duration', /dur[ée]e|pr[ée]avis|p[ée]riode/i],
  ['date', /date|effet|d[ée]but|prise en/i],
  ['identity', /identit[ée]|nom|pr[ée]nom|raison sociale|qualit[ée]|bailleur|locataire|prestataire|stagiaire|employeur|employ[ée]|entreprise|autorit[ée]|repr[ée]sentant|signataire/i],
  ['place', /logement|bien|local|adresse|d[ée]signation|description|objet|immobilier/i],
];

/** Déduit la nature attendue d'un champ à partir de son clé et de son libellé. */
export function fieldKind(field: TemplateField): FieldKind {
  const haystack = `${field.key} ${field.label}`;
  for (const [kind, pattern] of KIND_RULES) {
    if (pattern.test(haystack)) return kind;
  }
  return 'text';
}

/* ------------------------------------------------------------------ */
/* Détection de données dans le texte de l'utilisateur                  */
/* ------------------------------------------------------------------ */

const MONEY = /\d[\d\s  .]*\s*(?:FCFA|XOF|francs?\s*CFA)/i;
const DURATION = /\b\d+\s*(?:mois|an|ans|ann[ée]es|jour|jours|semaine|semaines|semestre|semestres|trimestre|trimestres)\b/i;
const DATE = new RegExp(
  '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b'
  + '|\\b\\d{1,2}\\s+(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\\b',
  'i',
);
const PLACE = /\b(?:à|de|du|des|en|au|aux|vers|rue|avenue|boulevard|quartier)\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]{2,}/u;

/**
 * Mots capitalisés du texte qui ne sont pas des mots du vocabulaire du modèle.
 *
 * Ce sont les candidats à un nom propre inventé. Un mot capitalisé qui figure
 * dans le vocabulaire du type de contrat (« Bailleur », « Locataire », « Partie »)
 * n'en est pas un.
 */
export function capitalizedCandidates(text: string, vocabulary: Set<string>): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*[-*>\d.)\s]+/, '');
    const words = cleaned.split(/\s+/);
    let atSentenceStart = true;
    for (const word of words) {
      const bare = word.replace(/[^\p{L}'’-]/gu, '');
      const key = normalizeKey(bare);
      if (atSentenceStart) {
        atSentenceStart = false;
        continue;
      }
      if (bare.length >= 3 && /^\p{Lu}/u.test(bare) && !vocabulary.has(key)) {
        found.add(bare);
      }
      if (/[.:!?»”]$/.test(word)) atSentenceStart = true;
    }
  }
  return [...found];
}

/** Une donnée de la nature attendue a-t-elle été fournie ? */
export function hasDatum(kind: FieldKind, text: string, vocabulary: Set<string>): boolean {
  switch (kind) {
    case 'money':
      return MONEY.test(text);
    case 'duration':
      return DURATION.test(text);
    case 'date':
      return DATE.test(text);
    case 'place':
      return PLACE.test(text);
    case 'identity':
      return capitalizedCandidates(text, vocabulary).length > 0;
    case 'text':
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/* Association champ <-> espace réservé du squelette                   */
/* ------------------------------------------------------------------ */

/** Les espaces réservés présents dans le squelette du modèle. */
export function skeletonPlaceholders(template: ContractTemplate): string[] {
  return template.skeleton_markdown.match(/\[À COMPLÉTER[^\]]*\]/g) ?? [];
}

/**
 * Espaces réservés du squelette associés à un champ.
 *
 * Association par mot-clé : on retient les espaces dont la description
 * contient un mot significatif de la clé du champ (« bailleur » →
 * « nom complet du bailleur »). Une clé sans correspondance ne renvoie rien :
 * on ne peut alors rien affirmer, et le champ n'est pas signalé.
 */
export function placeholdersForField(template: ContractTemplate, field: TemplateField): string[] {
  const tokens = field.key
    .split(/[_\s-]+/)
    .map((token) => normalizeKey(token))
    .filter((token) => token.length >= 4);

  if (tokens.length === 0) return [];

  return skeletonPlaceholders(template).filter((placeholder) => {
    const description = normalizeKey(placeholder.replace(/^\[\s*À COMPLÉTER\s*:\s*/i, '').replace(/\]$/, ''));
    return tokens.some((token) => description.includes(token));
  });
}

/* ------------------------------------------------------------------ */
/* Champs obligatoires : manquants / renseignés                         */
/* ------------------------------------------------------------------ */

/**
 * Champs obligatoires encore vides dans le document produit.
 *
 * Un champ est « vide » quand tous les espaces réservés qui lui sont
 * associés sont toujours présents dans le document : le modèle n'a rien
 * mis à la place.
 */
export function missingRequiredFields(
  template: ContractTemplate,
  markdown: string,
): TemplateField[] {
  const missing: TemplateField[] = [];
  for (const field of template.required_fields) {
    const related = placeholdersForField(template, field);
    if (related.length === 0) continue;
    if (related.every((placeholder) => markdown.includes(placeholder))) {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * Champs obligatoires que l'utilisateur a renseignés.
 *
 * Un champ est renseigné si :
 *  - une donnée de la nature attendue figure dans ses messages, ou
 *  - l'espace réservé qui lui est associé a disparu du document produit
 *    (le modèle l'a remplacé par une valeur).
 */
export function informedRequiredFields(
  template: ContractTemplate,
  userText: string,
  producedMarkdown: string,
  vocabulary: Set<string>,
): { informed: TemplateField[]; uninformed: TemplateField[] } {
  const informed: TemplateField[] = [];
  const uninformed: TemplateField[] = [];

  for (const field of template.required_fields) {
    const kind = fieldKind(field);
    const byUser = hasDatum(kind, userText, vocabulary);
    const related = placeholdersForField(template, field);
    const filledInDocument =
      related.length > 0 && related.some((placeholder) => !producedMarkdown.includes(placeholder));

    if (byUser || filledInDocument) informed.push(field);
    else uninformed.push(field);
  }

  return { informed, uninformed };
}
