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
/**
 * Lieu : un nom propre après une préposition de lieu.
 *
 * Attention : `\b` ne convient pas avant une lettre accentuée (« à » n'est
 * pas un caractère `\w` en JavaScript) : on utilise `(?:^|\s)`.
 */
const PLACE = /(?:^|\s)(?:à|de|du|des|en|au|aux|vers|rue|avenue|boulevard|quartier)\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]{2,}/u;

/**
 * Mots capitalisés du texte qui ne sont pas des mots du vocabulaire du modèle.
 *
 * Ce sont les candidats à un nom propre inventé. Un mot capitalisé qui figure
 * dans le vocabulaire du type de contrat (« Bailleur », « Locataire », « Partie »)
 * n'en est pas un. Les sigles tout en majuscules (« CDI », « SARL ») sont
 * écartés : ils ne constituent pas une identité.
 */
export function capitalizedCandidates(text: string, vocabulary: Set<string>): string[] {
  const found = new Set<string>();
  for (const line of (text ?? '').split(/\r?\n/)) {
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
        // Un sigle (« CDI », « SARL ») n'est pas une identité : il garde
        // toutes ses lettres en majuscule.
        if (!/^\p{Lu}+$/u.test(bare)) found.add(bare);
      }
      if (/[.:!?»”]$/.test(word)) atSentenceStart = true;
    }
  }
  return [...found];
}

/**
 * Un terme de civilité suivi d'un nom : « Monsieur Koné », « SARL Plateau ».
 * `\b` ne convient pas avant une lettre accentuée : on utilise `(?:^|\s)`.
 */
const CIVIL_TITLE = /(?:^|\s)(?:M\.|Mr|Mme|Mlle|Monsieur|Madame|Ma[îi]tre|Docteur|Soci[ée]t[ée]|Sarl|S\.?A\.?|Eurl|Sasu|Sp[rl])\b/u;

/**
 * Mots significatifs d'un champ (clé et libellé), utilisés pour les champs
 * de nature « texte » : on regarde si l'utilisateur a spoken du champ.
 */
function fieldTokens(field: TemplateField): string[] {
  const source = `${field.key} ${field.label}`;
  return source
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => normalizeKey(token))
    .filter((token) => token.length >= 4);
}

/** Une donnée de la nature attendue a-t-elle été fournie ? */
export function hasDatum(
  kind: FieldKind,
  text: string,
  vocabulary: Set<string>,
  field?: TemplateField,
): boolean {
  const source = text ?? '';
  switch (kind) {
    case 'money':
      return MONEY.test(source);
    case 'duration':
      return DURATION.test(source);
    case 'date':
      return DATE.test(source);
    case 'place':
      return PLACE.test(source);
    case 'identity':
      return capitalizedCandidates(source, vocabulary).length > 0
        || CIVIL_TITLE.test(source);
    case 'text':
    default: {
      if (!field) return false;
      const normalized = normalizeKey(source);
      return fieldTokens(field).some((token) => normalized.includes(token));
    }
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

/** Vocabulaire d'un type de contrat : son squelette et ses notes juridiques. */
export function templateVocabulary(template: ContractTemplate): Set<string> {
  const words = new Set<string>();
  const add = (text: string) => {
    for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 3) words.add(normalizeKey(word));
    }
  };
  add(template.skeleton_markdown);
  for (const note of template.legal_notes) add(note);
  for (const article of template.required_articles) add(article);
  for (const field of [...template.required_fields, ...template.optional_fields]) {
    add(field.key);
    add(field.label);
  }
  return words;
}

/**
 * Champs obligatoires encore vides dans le document produit.
 *
 * Un champ est renseigné si le document contient une donnée de la nature
 * attendue (un montant pour un champ « loyer », un nom pour un champ
 * « bailleur »). On ne se fie pas à la seule disparition de l'espace
 * réservé : le modèle peut supprimer un espace réservé sans rien mettre à la
 * place.
 */
export function missingRequiredFields(
  template: ContractTemplate,
  markdown: string,
): TemplateField[] {
  const vocabulary = templateVocabulary(template);
  const missing: TemplateField[] = [];

  for (const field of template.required_fields) {
    if (!hasDatum(fieldKind(field), markdown, vocabulary, field)) {
      missing.push(field);
    }
  }

  return missing;
}

/**
 * Champs obligatoires que l'utilisateur a renseignés.
 *
 * Un champ est renseigné si une donnée de la nature attendue figure dans les
 * messages de l'utilisateur. On ne se fie pas au document produit : le modèle
 * peut y avoir inventé une valeur.
 */
export function informedRequiredFields(
  template: ContractTemplate,
  userText: string,
  _producedMarkdown: string,
  vocabulary: Set<string>,
): { informed: TemplateField[]; uninformed: TemplateField[] } {
  const informed: TemplateField[] = [];
  const uninformed: TemplateField[] = [];

  for (const field of template.required_fields) {
    const kind = fieldKind(field);
    if (hasDatum(kind, userText, vocabulary, field)) informed.push(field);
    else uninformed.push(field);
  }

  return { informed, uninformed };
}
