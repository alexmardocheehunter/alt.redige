/**
 * The three tools of the agent: their definition (sent to the model) and their
 * execution (server side). Everything a tool writes to the Canvas goes through
 * the `emit` callback, so the SSE contract stays in one place.
 */
import { applyEdits, type Edit } from '../doc/edit.js';
import { randomUUID } from 'node:crypto';
import { validate } from '../doc/validate.js';
import { lostArticles, countChangedBlocks, renumberArticles } from '../doc/structure.js';
import { informedRequiredFields, placeholdersForField } from '../doc/required-fields.js';
import { checkReferences } from '../doc/references.js';
import { checkFacts } from '../doc/facts.js';
import type { Issue } from '../doc/validate.js';
import type { LlmClient, LlmToolDefinition } from '../llm.js';
import type { Logger } from '../logger.js';
import { checkTextSafety, looksLikeContract, shouldBlock } from '../safety.js';
import type { ContractTemplate, TemplateField, TemplateStore } from '../templates.js';
import type {
  AgentEmit,
  AskUserPayload,
  ClauseExplainedPayload,
  FieldStatus,
  QuestionField,
  QuestionOption,
} from './events.js';
import { checkExplanation, EXPLANATION_LIMITS, findArticle } from '../doc/explanation.js';
import { articles } from '../doc/structure.js';
import { listPlaceholders } from '../doc/placeholders.js';
import { computeDate } from '../doc/dates.js';
import {
  insertBlock,
  insertSignatureBlock,
  listToMarkdown,
  newEngagingArticles,
  replaceArticleBody,
  tableToMarkdown,
  userConsentedToClause,
  type SignatureParty,
} from '../doc/blocks.js';
import { blockingStructureIssues } from '../doc/structure-check.js';
import { buildSuggestions } from './progress.js';
import { applyCompanyProfilePrefill } from '../company/prefill.js';
import {
  CompanyProfileValidationError,
  isValidCompanyId,
  isProfileSaveConfirmed,
  mergeProfileFields,
  parseCompanyProfileFields,
  profileDisplayLabel,
} from '../company/profile.js';
import {
  CompanyProfileLimitError,
  type CompanyProfile,
  type CompanyProfileFields,
  type CompanyProfileInput,
  type CompanyProfileStore,
} from '../company/store.js';

export const TOOL_GET_TEMPLATE = 'get_template';
export const TOOL_CREATE_CANVAS = 'create_canvas';
export const TOOL_EDIT_CANVAS = 'edit_canvas';
export const TOOL_COMPUTE_DATE = 'compute_date';
export const TOOL_LIST_PLACEHOLDERS = 'list_placeholders';
export const TOOL_EDIT_ARTICLE = 'edit_article';
export const TOOL_INSERT_TABLE = 'insert_table';
export const TOOL_INSERT_LIST = 'insert_list';
export const TOOL_INSERT_SIGNATURE_BLOCK = 'insert_signature_block';
export const TOOL_SUGGEST_NEXT_ACTIONS = 'suggest_next_actions';
export const TOOL_GET_COMPANY_PROFILE = 'get_company_profile';
export const TOOL_SAVE_COMPANY_PROFILE = 'save_company_profile';

export interface ToolContext {
  /** Current working document, updated by the tools. */
  workingDoc: string | null;
  /** Type of contract of the current document (used to validate the articles). */
  workingDocType: string | null;
  templates: TemplateStore;
  emit: AgentEmit;
  /** Version to use for the next `canvas_set`. */
  nextVersion: () => number;
  logger: Logger;
  client: LlmClient;
  safetyModel: string;
  safetyEnabled: boolean;
  safetyMode: 'off' | 'advisory' | 'block';
  /**
   * Messages de l'utilisateur (historique) : servent à savoir si une
   * information exploitable a été fournie (garde-fou P0-3).
   */
  userText: string;
  /** Dernier message de l'utilisateur, pour le garde-fou de confirmation. */
  lastUserText: string;
  /** Profil d'entreprise sélectionné ou par défaut, sans données d'une autre partie. */
  companyProfile: CompanyProfile | null;
  /** Stockage des profils ; `null` avec le code partagé ou sans Firestore. */
  companyProfileStore: CompanyProfileStore | null;
  /** Identité individuelle Firebase ; `null` avec le code partagé. */
  uid: string | null;
  /** Version du document courant, reportée dans les explications de clause. */
  documentVersion: number;
  /**
   * Nombre maximal de blocs qu'une modification ciblée a le droit de
   * toucher. Au-delà, la modification est refusée (garde-fou P0-2).
   */
  maxEditChangedBlocks: number;
  /** Compteur des questions posées dans ce tour (identifiants uniques). */
  askUserCounter: number;
  signal: AbortSignal;
  /** Horloge du serveur, injectable pour les tests de dates. */
  now?: Date;
}

export interface ToolResult {
  /** JSON payload returned to the model. */
  content: string;
  isError: boolean;
  /** `true` si l'outil a effectivement émis un `canvas_set`. */
  emittedCanvasSet?: boolean;
  /** `true` si l'outil a posé une question : le tour s'arrête sur `awaiting_input`. */
  askedUser?: boolean;
  /** Résumé lisible, destiné au frontend (jamais les arguments bruts). */
  summary?: string;
}

export const TOOL_ASK_USER = 'ask_user';
export const TOOL_EXPLAIN_CLAUSE = 'explain_clause';

/**
 * Avertissement de revalidation juridique.
 *
 * Il est structuré (et non seulement une phrase de chat) : le frontend peut
 * l'afficher comme un bandeau attaché au document.
 */
export const LEGAL_NOTICE_TEXT =
  'Ce document doit être relu et validé par un professionnel du droit avant signature.';

/** Outil `ask_user` : l'agent pose une question et le tour s'arrête. */
export function askUserToolDefinition(): LlmToolDefinition {
  return {
    name: TOOL_ASK_USER,
    description:
      'Pose une question à l’utilisateur pour obtenir une information manquante. '
      + 'Le tour s’arrête : la réponse arrive au tour suivant. À utiliser quand une information '
      + 'indispensable manque, et une seule fois par tour (regroupe les questions dans un formulaire).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'La question, en français, en une phrase.' },
        kind: {
          type: 'string',
          enum: ['single', 'multi', 'text', 'confirm', 'form'],
          description: 'single : un choix ; multi : plusieurs choix ; text : une saisie ; confirm : oui/non ; form : plusieurs champs.',
        },
        why: { type: 'string', description: 'Pourquoi cette question est nécessaire (facultatif).' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } },
            required: ['id', 'label'],
          },
          description: 'Choix proposés (kind = single, multi, confirm).',
        },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string', enum: ['text', 'number', 'amount', 'date', 'select'] },
              required: { type: 'boolean' },
              placeholder: { type: 'string' },
              unit: { type: 'string' },
            },
            required: ['id', 'label', 'type', 'required'],
          },
          description: 'Champs à faire saisir (kind = form, 2 à 6 champs).',
        },
        allow_other: { type: 'boolean', description: 'L’utilisateur peut-il saisir une autre valeur ?' },
      },
      required: ['question', 'kind'],
    },
  };
}

/** Tool definitions sent to the model (format OpenAI / OpenRouter). */
export function toolDefinitions(templates: TemplateStore): LlmToolDefinition[] {
  const enumIds = templates.ready().map((template) => template.id);

  return [
    askUserToolDefinition(),
    {
      name: TOOL_EXPLAIN_CLAUSE,
      description:
        'Explique une clause du contrat à l\'utilisateur, à partir du texte présent dans le document. '
        + 'À appeler quand l\'utilisateur demande ce que signifie une clause. Ne jamais inventer '
        + 'une clause absente du document, ni citer un texte qui ne figure pas dans les notes.',
      parameters: {
        type: 'object',
        properties: {
          article: {
            type: 'string',
            description: 'Intitulé ou numéro de l\'article à expliquer, tel qu\'il figure dans le document.',
          },
          quote: {
            type: 'string',
            description: 'Extrait littéral de la clause, recopié exactement du document.',
          },
          explanation: {
            type: 'string',
            description: 'Explication en français, en langage courant, sans affirmation juridique non étayée.',
          },
          obligations: {
            type: 'array',
            description: 'Obligations qui découlent du texte de la clause.',
            items: {
              type: 'object',
              properties: {
                party: { type: 'string' },
                duty: { type: 'string' },
              },
              required: ['party', 'duty'],
            },
          },
          risks: {
            type: 'array',
            description: 'Points de vigilance pour l\'utilisateur.',
            items: { type: 'string' },
          },
          depends_on: {
            type: 'array',
            description: 'Éléments du contrat dont la valeur change la portée de la clause.',
            items: { type: 'string' },
          },
        },
        required: ['article', 'quote', 'explanation'],
      },
    },
    {
      name: TOOL_GET_TEMPLATE,
      description:
        'Charge le modèle de référence d’un type de contrat : squelette Markdown, champs attendus et notes juridiques vérifiées. À appeler avant de rédiger.',
      parameters: {
        type: 'object',
        properties: {
          contract_type: { type: 'string', enum: enumIds },
        },
        required: ['contract_type'],
      },
    },
    {
      name: TOOL_GET_COMPANY_PROFILE,
      description:
        'Relit le profil d’entreprise du compte connecté. Le profil est déjà injecté dans le contexte : '
        + 'ne l’appelle que pour vérifier une valeur. Ne jamais enregistrer ni modifier avec cet outil.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: TOOL_SAVE_COMPANY_PROFILE,
      description:
        'Enregistre ou modifie le profil d’entreprise du compte connecté. '
        + 'N’appelle cet outil qu’après une confirmation explicite de l’utilisateur, avec `confirmed: true`. '
        + 'Sans confirmation, le serveur refuse. Les champs absents sont conservés. '
        + 'Ne jamais enregistrer les données personnelles des autres parties.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Profil à modifier ; vide = profil courant.' },
          label: { type: 'string', description: 'Nom du profil dans le sélecteur.' },
          legal_name: { type: 'string', description: 'Raison sociale ou dénomination.' },
          legal_form: { type: 'string', description: 'Forme juridique.' },
          capital: { type: 'string', description: 'Capital social tel que saisi.' },
          rccm: { type: 'string', description: 'Numéro RCCM.' },
          tax_id: { type: 'string', description: 'Compte contribuable ou identifiant fiscal.' },
          address: { type: 'string', description: 'Adresse du siège.' },
          city: { type: 'string', description: 'Ville du siège.' },
          postal_box: { type: 'string', description: 'Boîte postale.' },
          representative_first_name: { type: 'string' },
          representative_last_name: { type: 'string' },
          representative_role: { type: 'string', description: 'Qualité ou fonction du représentant.' },
          phone: { type: 'string' },
          email: { type: 'string' },
          signature_place: { type: 'string', description: 'Lieu de signature habituel.' },
          is_default: { type: 'boolean', description: 'Définir ce profil comme profil par défaut.' },
          confirmed: {
            type: 'boolean',
            description: 'Vrai uniquement après une confirmation explicite de l’utilisateur.',
          },
        },
        required: ['confirmed'],
      },
    },
    {
      name: TOOL_CREATE_CANVAS,
      description:
        'Écrit le contrat complet dans le Canvas. Première version, ou recommencer de zéro avec replace=true.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          contract_type: { type: 'string' },
          markdown: { type: 'string', description: 'Contrat complet en Markdown restreint' },
          replace: { type: 'boolean' },
        },
        required: ['title', 'contract_type', 'markdown'],
      },
    },
    {
      name: TOOL_EDIT_CANVAS,
      description:
        'Modifie le document existant par remplacements ciblés. old_str doit être copié exactement du document courant et n’apparaître qu’une fois.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string', minLength: 1 },
                new_str: { type: 'string' },
              },
              required: ['old_str', 'new_str'],
            },
          },
        },
        required: ['edits'],
      },
    },
    {
      name: TOOL_COMPUTE_DATE,
      description:
        'Calcule une date de calendrier de façon fiable (fuseau Africa/Abidjan), par exemple le lundi suivant, '
        + 'ou trois mois après le début du contrat. À utiliser dès qu’une date ou une durée doit être calculée : '
        + 'ne calcule jamais une date de tête.',
      parameters: {
        type: 'object',
        properties: {
          start: {
            type: 'string',
            description: 'Date de départ : « today », « next_monday », « lundi prochain », « 2026-10-27 » ou « 27/10/2026 ».',
          },
          add: {
            type: 'object',
            description: 'Décalage à ajouter au calendrier.',
            properties: {
              years: { type: 'integer' },
              months: { type: 'integer' },
              weeks: { type: 'integer' },
              days: { type: 'integer' },
            },
          },
          inclusive: {
            type: 'boolean',
            description: 'Si vrai, la période inclut le jour de départ : la fin est la veille de l’anniversaire.',
          },
        },
        required: ['start'],
      },
    },
    {
      name: TOOL_LIST_PLACEHOLDERS,
      description:
        'Liste les espaces réservés « [À COMPLÉTER : …] » du document, avec l’article auquel chacun appartient. '
        + 'À utiliser pour savoir ce qui manque avant de proposer une suite.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: TOOL_EDIT_ARTICLE,
      description:
        'Remplace le corps d’un article existant, sans toucher à son titre ni aux autres articles. '
        + 'Le corps est du Markdown restreint (paragraphes, listes, tableaux).',
      parameters: {
        type: 'object',
        properties: {
          article: { type: 'string', description: 'Numéro (« 4 ») ou intitulé exact de l’article.' },
          markdown: { type: 'string', description: 'Nouveau corps de l’article, sans la ligne « ## Article … ».' },
        },
        required: ['article', 'markdown'],
      },
    },
    {
      name: TOOL_INSERT_TABLE,
      description:
        'Insère un vrai tableau GFM à la fin d’un article (ou du document). La première ligne est l’en-tête. '
        + 'À utiliser pour les signatures, les échéances ou tout tableau demandé.',
      parameters: {
        type: 'object',
        properties: {
          article: { type: 'string', description: 'Article où insérer le tableau ; vide = fin du document.' },
          rows: {
            type: 'array',
            minItems: 2,
            maxItems: 30,
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              items: { type: 'string' },
            },
            description: 'Lignes du tableau, première ligne = en-tête.',
          },
        },
        required: ['rows'],
      },
    },
    {
      name: TOOL_INSERT_LIST,
      description:
        'Insère une liste à puces ou numérotée à la fin d’un article (ou du document), sans réécrire le reste.',
      parameters: {
        type: 'object',
        properties: {
          article: { type: 'string', description: 'Article où insérer la liste ; vide = fin du document.' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: { type: 'string' },
          },
          ordered: { type: 'boolean', description: 'Liste numérotée si vrai, à puces sinon.' },
        },
        required: ['items'],
      },
    },
    {
      name: TOOL_INSERT_SIGNATURE_BLOCK,
      description:
        'Insère ou met à jour un bloc de signatures déterministe, en vrai tableau à deux colonnes pour deux parties, '
        + 'avec les lignes Lu et approuvé, Signature, Nom, Prénom, Fonction et Date. '
        + 'Utilise les noms déjà présents dans le contrat ; n’invente aucune identité.',
      parameters: {
        type: 'object',
        properties: {
          parties: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Nom de famille ou raison sociale.' },
                first_name: { type: 'string' },
                role: { type: 'string', description: 'Qualité : bailleur, locataire, prestataire…' },
                date: { type: 'string', description: 'Date de signature déjà connue, sinon vide.' },
              },
              required: ['name'],
            },
          },
          intro: {
            type: 'string',
            description: 'Phrase d’introduction existante (par exemple « Fait à Abidjan, le … »), sans invention.',
          },
        },
        required: ['parties'],
      },
    },
    {
      name: TOOL_SUGGEST_NEXT_ACTIONS,
      description:
        'Calcule et affiche les trois prochaines actions utiles selon l’état réel du document. '
        + 'À appeler à la fin d’un tour, après avoir écrit ou modifié le document.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ];
}

/**
 * État de remplissage des champs d'un type de contrat.
 *
 * Un champ est « rempli » quand au moins un de ses espaces réservés a été
 * remplacé dans le document. Un champ sans espace réservé associé n'a rien à
 * compléter : il est reporté comme rempli.
 */
function fieldStatuses(
  template: ContractTemplate | null,
  markdown: string,
): { required: FieldStatus[]; optional: FieldStatus[] } {
  if (!template) return { required: [], optional: [] };

  const status = (field: TemplateField): FieldStatus => {
    const placeholders = placeholdersForField(template, field);
    const filled = placeholders.length === 0
      || placeholders.some((placeholder) => !markdown.includes(placeholder));
    return { key: field.key, label: field.label, filled };
  };

  return {
    required: template.required_fields.map(status),
    optional: template.optional_fields.map(status),
  };
}

function ok(payload: unknown): ToolResult {
  return { content: JSON.stringify(payload), isError: false };
}

function fail(message: string, payload: Record<string, unknown> = {}): ToolResult {
  return { content: JSON.stringify({ error: message, ...payload }), isError: true };
}

/** Payload returned by `get_template`. */
export function templatePayload(template: ContractTemplate): Record<string, unknown> {
  return {
    id: template.id,
    label: template.label,
    required_articles: template.required_articles,
    required_fields: template.required_fields,
    optional_fields: template.optional_fields,
    legal_notes: template.legal_notes,
    skeleton_markdown: template.skeleton_markdown,
  };
}

/**
 * Checks a document against the safety model.
 * The guardian failing (network, quota) never blocks: the contract is kept.
 */
async function documentIsSafe(
  context: ToolContext,
  markdown: string,
): Promise<{ safe: boolean; available: boolean; inDomain: boolean }> {
  if (!context.safetyEnabled) {
    return { safe: true, available: false, inDomain: true };
  }

  const verdict = await checkTextSafety({
    client: context.client,
    model: context.safetyModel,
    text: markdown,
    signal: context.signal,
    logger: context.logger,
  });

  // Un document qui a la forme d'un contrat est dans le domaine : le gardien
  // se trompe trop souvent sur le droit français pour le bloquer.
  const inDomain = verdict.inDomain || looksLikeContract(markdown);
  const blocked = shouldBlock(
    { ...verdict, inDomain },
    context.safetyMode,
    inDomain,
  );

  if (!verdict.safe) {
    context.logger.warn(blocked ? 'safety_blocked_document' : 'safety_flagged_document', {
      in_domain: inDomain,
    });
  }

  return { safe: !blocked, available: verdict.available, inDomain };
}

/**
 * Executes a tool.
 * Returns the payload sent back to the model.
 */
export async function executeTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (name) {
    case TOOL_GET_TEMPLATE:
      return getTemplate(args, context);
    case TOOL_CREATE_CANVAS:
      return createCanvas(args, context);
    case TOOL_EDIT_CANVAS:
      return editCanvas(args, context);
    case TOOL_EDIT_ARTICLE:
      return editArticle(args, context);
    case TOOL_INSERT_TABLE:
      return insertTable(args, context);
    case TOOL_INSERT_LIST:
      return insertList(args, context);
    case TOOL_INSERT_SIGNATURE_BLOCK:
      return insertSignature(args, context);
    case TOOL_COMPUTE_DATE:
      return computeDateTool(args, context);
    case TOOL_LIST_PLACEHOLDERS:
      return listPlaceholdersTool(args, context);
    case TOOL_SUGGEST_NEXT_ACTIONS:
      return suggestNextActions(args, context);
    case TOOL_GET_COMPANY_PROFILE:
      return getCompanyProfile(context);
    case TOOL_SAVE_COMPANY_PROFILE:
      return saveCompanyProfile(args, context);
    case TOOL_ASK_USER:
      return askUser(args, context);
    case TOOL_EXPLAIN_CLAUSE:
      return explainClause(args, context);
    default:
      return fail(`Outil inconnu : ${name}.`);
  }
}

/**
 * Profil envoyé au modèle : jamais le logo (une data URL peut être énorme).
 */
function companyProfileToolPayload(profile: CompanyProfile): Record<string, unknown> {
  const { logo, ...fields } = profile;
  return { ...fields, has_logo: Boolean(logo) };
}

async function getCompanyProfile(context: ToolContext): Promise<ToolResult> {
  let profile = context.companyProfile;
  if (!profile && context.companyProfileStore && context.uid) {
    try {
      profile = await context.companyProfileStore.getDefault(context.uid);
    } catch (error) {
      context.logger.warn('company_profile_tool_unavailable', {
        operation: 'get_default',
        error_kind: error instanceof Error ? error.name : typeof error,
      });
      return fail('Le profil d’entreprise est momentanément indisponible. Réessayez.');
    }
  }
  return ok({ profile: profile ? companyProfileToolPayload(profile) : null });
}

async function saveCompanyProfile(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.companyProfileStore || !context.uid) {
    return fail(
      'La sauvegarde du profil d’entreprise nécessite une connexion Google individuelle. '
      + 'Aucune donnée n’a été enregistrée.',
    );
  }

  if (args.confirmed !== true || !isProfileSaveConfirmed(context.lastUserText)) {
    context.logger.info('tool_save_company_profile_refused', { code: 'confirmation_required' });
    return fail(
      'Confirmation requise : demande d’abord à l’utilisateur s’il veut enregistrer ces informations, '
      + 'puis attends un « oui » explicite. Ne réessaie pas avant sa réponse. Aucune donnée n’a été enregistrée.',
      { code: 'confirmation_required', confirmation_required: true },
    );
  }

  let patch: Partial<CompanyProfileFields>;
  let isDefault: boolean | undefined;
  try {
    const parsed = parseCompanyProfileFields(args, { partial: true });
    patch = parsed.fields;
    isDefault = parsed.isDefault;
  } catch (error) {
    if (error instanceof CompanyProfileValidationError) {
      return fail(error.message, { code: error.code });
    }
    throw error;
  }

  const rawId = typeof args.id === 'string' ? args.id.trim() : '';
  if (rawId && !isValidCompanyId(rawId)) {
    return fail('Identifiant de profil invalide.');
  }
  const targetId = rawId || context.companyProfile?.id || randomUUID();

  let existing: CompanyProfile | null = null;
  try {
    existing = await context.companyProfileStore.get(context.uid, targetId);
  } catch (error) {
    context.logger.warn('company_profile_tool_unavailable', {
      operation: 'get',
      error_kind: error instanceof Error ? error.name : typeof error,
    });
    return fail('Le profil d’entreprise est momentanément indisponible. Réessayez.');
  }

  let input: CompanyProfileInput;
  try {
    input = mergeProfileFields(existing, patch);
  } catch (error) {
    if (error instanceof CompanyProfileValidationError) {
      return fail(error.message, { code: error.code });
    }
    throw error;
  }

  let saved: CompanyProfile;
  try {
    saved = await context.companyProfileStore.put(
      context.uid,
      targetId,
      isDefault === undefined ? input : { ...input, is_default: isDefault },
    );
  } catch (error) {
    if (error instanceof CompanyProfileLimitError) {
      return fail('Vous avez atteint la limite de cinq profils d’entreprise.');
    }
    context.logger.warn('company_profile_tool_unavailable', {
      operation: 'put',
      error_kind: error instanceof Error ? error.name : typeof error,
    });
    return fail('L’enregistrement du profil a échoué. Réessayez.');
  }

  context.companyProfile = saved;
  context.logger.info('tool_save_company_profile', {
    created: existing === null,
    fields: Object.keys(patch).length,
  });

  return {
    content: JSON.stringify({
      ok: true,
      profile: {
        id: saved.id,
        label: profileDisplayLabel(saved),
        is_default: saved.is_default,
      },
      note: 'Profil enregistré. Le document courant n’a pas été modifié.',
    }),
    isError: false,
    summary: 'Profil d’entreprise enregistré',
  };
}

/**
 * L'agent explique une clause du contrat.
 *
 * L'explication est contrôlée avant d'être émise : l'extrait doit figurer dans
 * le document, aucune affirmation juridique non étayée, aucune citation hors du
 * référentiel, aucune mention de limite absente.
 */
function explainClause(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const document = context.workingDoc;
  if (!document) {
    return fail('Aucun contrat à expliquer : le Canvas est vide.');
  }

  const wanted = typeof args.article === 'string' ? args.article.trim() : '';
  if (!wanted) {
    return fail('Indique l\'article à expliquer.');
  }

  const found = findArticle(document, wanted);
  if (!found) {
    const available = articles(document).map((article) => article.title).join(', ');
    return fail(
      `L'article « ${wanted} » ne figure pas dans le contrat. Les articles disponibles sont : ${available}`,
    );
  }

  const quote = typeof args.quote === 'string' ? args.quote.trim() : '';
  const explanation = typeof args.explanation === 'string' ? args.explanation.trim() : '';
  if (!explanation) {
    return fail('L\'explication est vide.');
  }

  const template = context.workingDocType ? context.templates.get(context.workingDocType) ?? null : null;
  const payload: ClauseExplainedPayload = {
    article: found.title,
    quote: quote || found.title,
    explanation,
    obligations: Array.isArray(args.obligations)
      ? (args.obligations as Array<Record<string, unknown>>).map((item) => ({
        party: String(item.party ?? ''),
        duty: String(item.duty ?? ''),
      }))
      : [],
    risks: Array.isArray(args.risks) ? (args.risks as unknown[]).map((risk) => String(risk)) : [],
    depends_on: Array.isArray(args.depends_on)
      ? (args.depends_on as unknown[]).map((item) => String(item))
      : [],
    limits: EXPLANATION_LIMITS,
    document_version: context.documentVersion,
  };

  const problems = checkExplanation(payload, document, template);
  if (problems.length > 0) {
    context.logger.info('tool_explain_clause_refused', { problems: problems.length });
    return fail(
      `L'explication ne peut pas être publiée : ${problems.join(' ')} Corrige et recommence.`,
      { problems },
    );
  }

  context.emit('clause_explained', payload);
  context.logger.info('tool_explain_clause', { article: payload.article });

  return ok({
    ok: true,
    article: payload.article,
    explanation: payload.explanation,
    risks: payload.risks,
    limits: payload.limits,
  });
}

/**
 * L'agent pose une question à l'utilisateur.
 *
 * Le tour s'arrête : l'événement `ask_user` est émis, puis la boucle se
 * termine sur `done` avec `stop_reason: "awaiting_input"`. La réponse
 * arrive au tour suivant, sous forme de texte dans l'historique.
 */
function askUser(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) {
    return fail('La question est vide : indique ce que tu dois savoir.');
  }

  const kind = (typeof args.kind === 'string' ? args.kind : 'text') as AskUserPayload['kind'];
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options: QuestionOption[] = rawOptions
    .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object')
    .map((option) => ({
      id: String(option.id ?? option.label ?? ''),
      label: String(option.label ?? option.id ?? ''),
      ...(option.hint ? { hint: String(option.hint) } : {}),
    }))
    .filter((option) => option.id && option.label);

  const rawFields = Array.isArray(args.fields) ? args.fields : [];
  const fields: QuestionField[] = rawFields
    .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object')
    .map((field) => ({
      id: String(field.id ?? field.label ?? ''),
      label: String(field.label ?? field.id ?? ''),
      type: (String(field.type ?? 'text')) as QuestionField['type'],
      required: field.required === true,
      ...(field.placeholder ? { placeholder: String(field.placeholder) } : {}),
      ...(field.unit ? { unit: String(field.unit) } : {}),
    }))
    .filter((field) => field.id && field.label)
    .slice(0, 6);

  const payload: AskUserPayload = {
    question_id: `q_${context.askUserCounter++}`,
    kind,
    question,
    blocking: true,
    allow_other: args.allow_other === true,
    ...(typeof args.why === 'string' && args.why.trim() ? { why: args.why.trim() } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(fields.length > 0 ? { fields } : {}),
  };

  context.emit('ask_user', payload);
  context.logger.info('tool_ask_user', { kind, options: options.length, fields: fields.length });

  return {
    content: JSON.stringify({
      ok: true,
      asked: true,
      question_id: payload.question_id,
      note: 'La question a été posée à l’utilisateur. Le tour s’arrête ici : ne rédige pas de contrat.',
    }),
    isError: false,
    askedUser: true,
    summary: 'Question posée',
  };
}

function getTemplate(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const contractType = typeof args.contract_type === 'string' ? args.contract_type : '';
  const template = context.templates.get(contractType);

  if (!template) {
    const valid = context.templates.ready().map((item) => item.id);
    return fail(
      `Type de contrat inconnu : « ${contractType} ». Types disponibles : ${valid.join(', ')}.`,
      { valid_contract_types: valid },
    );
  }

  context.emit('status', { phase: 'template', label: `Chargement du modèle « ${template.label} »…` });
  context.logger.debug('tool_get_template', { contract_type: template.id });
  return { ...ok(templatePayload(template)), summary: `Modèle « ${template.label} »` };
}

/**
 * Contrôle des faits : le document ne doit pas affirmer un montant, une
 * durée, une date ou un nom propre que personne n'a fourni (P1-3).
 *
 * Le résultat est un avertissement, pas un refus : une coquille vide est
 * bloquée, mais une valeur approximative reste signalée à l'utilisateur.
 */
function factIssues(markdown: string, context: ToolContext, template: ContractTemplate | null): Issue[] {
  const problems = checkFacts(markdown, context.userText, template);
  if (problems.length === 0) return [];
  return [{
    code: 'fact_unverified',
    severity: 'warning',
    message: `Information(s) présente(s) dans le document mais absente(s) de la demande : `
      + `${problems.slice(0, 10).map((problem) => `${problem.value} (${problem.detail})`).join(', ')}`
      + `${problems.length > 10 ? `, et ${problems.length - 10} autre(s)` : ''}.`,
  }];
}

async function createCanvas(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const contractType = typeof args.contract_type === 'string' ? args.contract_type.trim() : '';
  let markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const replace = args.replace === true;

  if (!markdown.trim()) {
    return fail('Le contrat est vide : rien à écrire dans le Canvas.');
  }

  // Liste blanche : le type produit doit exister dans le catalogue. Sans ce
  // contrôle, le modèle peut rédiger un type hors périmètre, et le document
  // est alors validé contre le mauvais modèle (P1-1 / P2-2).
  const knownTypes = context.templates.all().map((item) => item.id);
  if (!knownTypes.includes(contractType)) {
    return fail(
      `Type de contrat inconnu : « ${contractType} ». Types disponibles : ${knownTypes.join(', ')}. `
      + 'Choisis un type du catalogue, ou dis clairement à l’utilisateur que ce type n’est pas pris en charge.',
      { valid_contract_types: knownTypes },
    );
  }

  if (context.workingDoc !== null && !replace) {
    return fail(
      'Un document existe déjà dans le Canvas. Utilise edit_canvas pour le modifier, ou create_canvas avec replace=true pour tout recommencer.',
    );
  }

  const template = context.templates.get(contractType) ?? null;

  // Garde-fou P0-3 : sans information exploitable de l'utilisateur, le
  // modèle doit poser des questions, pas rédiger un contrat.
  //
  // Le contrôle porte sur l'**historique** : un document produit ne prouve
  // rien, puisque le modèle peut y avoir inventé les valeurs. Si aucun champ
  // obligatoire n'est renseigné par l'utilisateur, l'écriture est refusée et
  // l'utilisateur reçoit une question structurée (AGENT-PROTOCOL.md §8).
  if (template) {
    const vocabulary = context.templates.vocabulary();
    const { informed, uninformed } = informedRequiredFields(
      template,
      context.userText,
      markdown,
      vocabulary,
    );
    if (informed.length === 0 && uninformed.length > 0) {
      const missing = uninformed.map((field) => field.label).join(', ');
      context.logger.info('tool_create_canvas_refused', {
        contract_type: contractType,
        missing_required_fields: uninformed.length,
      });

      // Une seule question par tour (AGENT-PROTOCOL.md §8) : les champs
      // manquants sont regroupés dans un formulaire.
      const payload: AskUserPayload = {
        question_id: `q_${context.askUserCounter++}`,
        kind: uninformed.length > 1 ? 'form' : 'text',
        question: uninformed.length > 1
          ? `Pour rédiger « ${template.label} », il me manque quelques informations.`
          : `Pour rédiger « ${template.label} », il me manque : ${missing}.`,
        why: 'Ces informations sont obligatoires : sans elles, le contrat serait incomplet ou fictif.',
        blocking: true,
        allow_other: true,
        ...(uninformed.length > 1
          ? {
            fields: uninformed.slice(0, 6).map((field) => ({
              id: field.key,
              label: field.label,
              type: 'text' as const,
              required: true,
              placeholder: field.question_hint,
            })),
          }
          : {}),
      };
      context.emit('ask_user', payload);

      return {
        content: JSON.stringify({
          asked: true,
          question_id: payload.question_id,
          missing_required_fields: uninformed.map((field) => field.key),
          note: 'Question posée à l’utilisateur. Le tour s’arrête : ne rédige pas de contrat.',
        }),
        isError: false,
        askedUser: true,
      };
    }
  }

  // Préremplissage employeur : déterministe, côté serveur, uniquement pour les
  // contrats où le profil est du côté employeur. Les champs de l'autre partie
  // restent des espaces réservés.
  const prefilled = applyCompanyProfilePrefill(markdown, context.companyProfile, contractType);
  markdown = prefilled.markdown;

  // Garde-fou P1-2 : aucune mention normative hors du référentiel du modèle.
  const unsupported = checkReferences(markdown, template);
  if (unsupported.length > 0) {
    context.logger.info('tool_create_canvas_refused', {
      contract_type: contractType,
      unsupported_references: unsupported.length,
    });
    return fail(
      `Le contrat cite une référence normative absente du référentiel validé de « ${template?.label ?? contractType} » : `
      + `${unsupported.join(', ')}. Retire ces mentions, ou remplace-les par une formulation générale sans citation.`,
      { unsupported_references: unsupported },
    );
  }

  const safety = await documentIsSafe(context, markdown);
  if (!safety.safe) {
    context.logger.warn('safety_blocked_document', { contract_type: contractType });
    return fail(
      'Le contenu rédigé a été bloqué par le filtre de sécurité. Ne le réécris pas tel quel : explique à l’utilisateur que sa demande ne peut pas être traitée.',
    );
  }

  const structure = blockingStructureIssues(markdown);
  if (structure.length > 0) {
    context.logger.info('tool_create_canvas_refused', {
      contract_type: contractType,
      invalid_structure: structure.length,
    });
    return fail(
      `Le contrat contient une structure invalide : ${structure.map((item) => item.message).join(' ')} `
      + 'Corrige le tableau ou la numérotation, puis recommence.',
      { code: 'invalid_structure', problems: structure },
    );
  }

  const validation = validate(markdown, template);
  validation.issues.push(...factIssues(markdown, context, template));

  context.workingDoc = markdown;
  context.workingDocType = contractType;

  context.emit('canvas_set', {
    mode: 'create',
    markdown,
    version: context.nextVersion(),
    title,
    contract_type: contractType,
    validation: {
      placeholders: validation.placeholders,
      issues: validation.issues,
      fields: fieldStatuses(template, markdown),
    },
    legal_notice: { required: true, text: LEGAL_NOTICE_TEXT },
  });

  context.logger.info('tool_create_canvas', {
    contract_type: contractType,
    placeholders: validation.placeholders,
    prefilled: prefilled.filled,
    issues: validation.issues.length,
    safety: safety.available ? 'checked' : 'skipped',
  });

  return {
    content: JSON.stringify({
      ok: true,
      placeholders: validation.placeholders,
      issues: validation.issues,
      title,
      contract_type: contractType,
    }),
    isError: false,
    emittedCanvasSet: true,
    summary: validation.placeholders > 0
      ? `Contrat écrit, ${validation.placeholders} champ(s) à compléter`
      : 'Contrat écrit',
  };
}

async function editCanvas(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  const edits: Edit[] = [];

  for (const raw of rawEdits) {
    if (!raw || typeof raw !== 'object') continue;
    const edit = raw as Record<string, unknown>;
    edits.push({
      old_str: typeof edit.old_str === 'string' ? edit.old_str : '',
      new_str: typeof edit.new_str === 'string' ? edit.new_str : '',
    });
  }

  const result = applyEdits(context.workingDoc, edits);

  if (!result.ok) {
    context.logger.info('tool_edit_canvas_failed', { code: result.code, index: result.index });
    return fail(result.message, { code: result.code, edit_index: result.index });
  }

  // Garde-fou P0-2 : une modification « ciblée » ne doit pas faire disparaître
  // un article (bloc de signatures compris) ni réécrire le document entier.
  const before = context.workingDoc ?? '';
  const lost = lostArticles(before, result.markdown);
  if (lost.length > 0) {
    context.logger.info('tool_edit_canvas_failed', { code: 'article_lost', articles: lost.length });
    return fail(
      `La modification fait disparaître ${lost.length} article(s) du contrat : ${lost.join(', ')}. `
      + 'Une modification ciblée ne doit retirer aucun article. Refais l’édition en remplaçant uniquement le texte demandé, '
      + 'sans reformuler ni supprimer les autres articles.',
      { code: 'article_lost', lost_articles: lost },
    );
  }

  const changed = countChangedBlocks(before, result.markdown);
  if (changed.changed > context.maxEditChangedBlocks) {
    context.logger.info('tool_edit_canvas_failed', { code: 'too_many_changes', changed: changed.changed });
    return fail(
      `La modification touche ${changed.changed} blocs du contrat, plus que la limite de ${context.maxEditChangedBlocks}. `
      + 'Regroupe les changements demandés en un seul remplacement ciblé, sans réécrire le document.',
      { code: 'too_many_changes', changed_blocks: changed.changed, limit: context.maxEditChangedBlocks },
    );
  }

  // Le serveur est l'autorité sur la numérotation des articles : le modèle
  // peut écrire n'importe quel numéro, il est corrigé ici, et les renvois
  // internes suivent le déplacement de l'article visé.
  const renumbered = renumberArticles(before, result.markdown);
  if (renumbered.changed) {
    context.logger.info('tool_edit_canvas_renumbered', { articles: renumbered.mapping.size });
  }
  result.markdown = renumbered.markdown;

  const structure = blockingStructureIssues(result.markdown);
  if (structure.length > 0) {
    context.logger.info('tool_edit_canvas_failed', { code: 'invalid_structure', problems: structure.length });
    return fail(
      `La modification produit une structure invalide : ${structure.map((item) => item.message).join(' ')} `
      + 'Corrige le tableau ou la numérotation, puis recommence.',
      { code: 'invalid_structure', problems: structure },
    );
  }

  // Une clause qui crée une obligation importante ne s'insère qu'après un
  // accord explicite : le modèle doit poser la question avant.
  const engaging = newEngagingArticles(before, result.markdown);
  if (engaging.length > 0 && !userConsentedToClause(context.userText)) {
    context.logger.info('tool_edit_canvas_failed', { code: 'clause_needs_confirmation', articles: engaging.length });
    return fail(
      `La modification crée une clause engageante (${engaging.join(', ')}) sans accord explicite. `
      + 'Pose une question de confirmation avec ask_user avant de l’insérer.',
      { code: 'clause_needs_confirmation', articles: engaging },
    );
  }

  // Garde-fou P1-2 : aucune mention normative hors du référentiel du modèle.
  const template = context.workingDocType ? context.templates.get(context.workingDocType) ?? null : null;
  const unsupported = checkReferences(result.markdown, template);
  if (unsupported.length > 0) {
    context.logger.info('tool_edit_canvas_failed', { code: 'unsupported_reference', references: unsupported.length });
    return fail(
      `La modification introduit une référence normative absente du référentiel validé : ${unsupported.join(', ')}. `
      + 'Retire ces mentions, ou remplace-les par une formulation générale sans citation.',
      { code: 'unsupported_reference', unsupported_references: unsupported },
    );
  }

  const safety = await documentIsSafe(context, result.markdown);
  if (!safety.safe) {
    context.logger.warn('safety_blocked_document', { mode: 'edit' });
    return fail(
      'La modification a été bloquée par le filtre de sécurité. Ne la réécris pas tel quelle : explique à l’utilisateur que sa demande ne peut pas être traitée.',
    );
  }

  const validation = validate(result.markdown, template);
  validation.issues.push(...factIssues(result.markdown, context, template));

  context.workingDoc = result.markdown;

  context.emit('canvas_start', { mode: 'edit' });
  context.emit('canvas_set', {
    mode: 'edit',
    markdown: result.markdown,
    version: context.nextVersion(),
    edits_applied: result.editsApplied,
    validation: { placeholders: validation.placeholders, issues: validation.issues },
  });

  context.logger.info('tool_edit_canvas', {
    edits_applied: result.editsApplied,
    placeholders: validation.placeholders,
    safety: safety.available ? 'checked' : 'skipped',
    changed_blocks: changed.changed,
  });

  return {
    content: JSON.stringify({
      ok: true,
      edits_applied: result.editsApplied,
      placeholders: validation.placeholders,
      issues: validation.issues,
    }),
    isError: false,
    emittedCanvasSet: true,
    summary: `${result.editsApplied} modification(s) appliquée(s)`,
  };
}

interface StructuredCommitOptions {
  editsApplied: number;
  summary: string;
  logEvent: string;
  maxChanged?: number;
}

/**
 * Common validation and emission for the structured tools.
 *
 * The checks are the same as `edit_canvas`: no lost article, no runaway
 * rewrite, no unsupported legal reference, no unsafe content. Table structure
 * and newly engaging clauses are checked here because these tools can create
 * blocks the model did not copy from the user's request.
 */
async function commitStructuredChange(
  context: ToolContext,
  before: string,
  after: string,
  options: StructuredCommitOptions,
): Promise<ToolResult> {
  if (!before) return fail('Aucun document à modifier : le Canvas est vide.');
  if (after === before) return fail('La modification ne change pas le document.');

  const lost = lostArticles(before, after);
  if (lost.length > 0) {
    context.logger.info('structured_edit_refused', { code: 'article_lost', articles: lost.length });
    return fail(
      `La modification fait disparaître ${lost.length} article(s) : ${lost.join(', ')}. `
      + 'Utilise un outil ciblé qui conserve tous les articles.',
      { code: 'article_lost', lost_articles: lost },
    );
  }

  const limit = options.maxChanged ?? context.maxEditChangedBlocks;
  const changed = countChangedBlocks(before, after);
  if (changed.changed > limit) {
    context.logger.info('structured_edit_refused', { code: 'too_many_changes', changed: changed.changed });
    return fail(
      `La modification touche ${changed.changed} blocs, au-delà de la limite de ${limit}. `
      + 'Modifie un seul article ou insère un seul bloc à la fois.',
      { code: 'too_many_changes', changed_blocks: changed.changed, limit },
    );
  }

  const renumbered = renumberArticles(before, after);
  after = renumbered.markdown;

  const structure = blockingStructureIssues(after);
  if (structure.length > 0) {
    context.logger.info('structured_edit_refused', { code: 'invalid_structure', problems: structure.length });
    return fail(
      `Le document produit a une structure invalide : ${structure.map((item) => item.message).join(' ')} `
      + 'Corrige le tableau ou la numérotation, puis recommence.',
      { code: 'invalid_structure', problems: structure },
    );
  }

  const template = context.workingDocType ? context.templates.get(context.workingDocType) ?? null : null;
  const unsupported = checkReferences(after, template);
  if (unsupported.length > 0) {
    context.logger.info('structured_edit_refused', { code: 'unsupported_reference', references: unsupported.length });
    return fail(
      `La modification introduit une référence normative absente du référentiel validé : ${unsupported.join(', ')}. `
      + 'Retire ces mentions ou utilise une formulation générale sans citation.',
      { code: 'unsupported_reference', unsupported_references: unsupported },
    );
  }

  const engaging = newEngagingArticles(before, after);
  if (engaging.length > 0 && !userConsentedToClause(context.userText)) {
    context.logger.info('structured_edit_refused', { code: 'clause_needs_confirmation', articles: engaging.length });
    return fail(
      `La modification crée une clause engageante (${engaging.join(', ')}) sans accord explicite de l’utilisateur. `
      + 'Ne l’insère pas encore : pose une question de confirmation avec ask_user, puis attends la réponse.',
      { code: 'clause_needs_confirmation', articles: engaging },
    );
  }

  const safety = await documentIsSafe(context, after);
  if (!safety.safe) {
    context.logger.warn('safety_blocked_document', { mode: 'structured_edit' });
    return fail(
      'La modification a été bloquée par le filtre de sécurité. Explique à l’utilisateur que sa demande ne peut pas être traitée.',
    );
  }

  const validation = validate(after, template);
  validation.issues.push(...factIssues(after, context, template));
  context.workingDoc = after;

  context.emit('canvas_start', { mode: 'edit' });
  context.emit('canvas_set', {
    mode: 'edit',
    markdown: after,
    version: context.nextVersion(),
    edits_applied: options.editsApplied,
    validation: {
      placeholders: validation.placeholders,
      issues: validation.issues,
      ...(template ? { fields: fieldStatuses(template, after) } : {}),
    },
    legal_notice: { required: true, text: LEGAL_NOTICE_TEXT },
  });

  context.logger.info(options.logEvent, {
    edits_applied: options.editsApplied,
    placeholders: validation.placeholders,
    safety: safety.available ? 'checked' : 'skipped',
    changed_blocks: changed.changed,
  });

  return {
    content: JSON.stringify({
      ok: true,
      edits_applied: options.editsApplied,
      placeholders: validation.placeholders,
      issues: validation.issues,
    }),
    isError: false,
    emittedCanvasSet: true,
    summary: options.summary,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

async function editArticle(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const article = stringArg(args, 'article');
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  if (!article) return fail('Indique l’article à modifier (numéro ou intitulé).');
  if (!markdown.trim()) return fail('Le nouveau corps de l’article est vide.');
  if (/^#{1,6}\s+/m.test(markdown)) {
    return fail('Le corps de l’article ne doit pas contenir de titre : le titre existant est conservé.');
  }
  if (!context.workingDoc) return fail('Aucun document à modifier : le Canvas est vide.');

  let after: string;
  try {
    after = replaceArticleBody(context.workingDoc, article, markdown);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Article introuvable.');
  }

  return commitStructuredChange(context, context.workingDoc, after, {
    editsApplied: 1,
    summary: `Article « ${article} » mis à jour`,
    logEvent: 'tool_edit_article',
    maxChanged: Math.max(context.maxEditChangedBlocks, 12),
  });
}

async function insertTable(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  if (!context.workingDoc) return fail('Aucun document à modifier : le Canvas est vide.');
  const rawRows = Array.isArray(args.rows) ? args.rows : [];
  if (rawRows.length < 2) return fail('Un tableau doit avoir une ligne d’en-tête et au moins une ligne de données.');

  const rows: string[][] = [];
  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow)) return fail('Chaque ligne du tableau doit être une liste de cellules.');
    const cells = rawRow.map((cell) => String(cell ?? ''));
    if (cells.some((cell) => cell.includes('\n'))) {
      return fail('Une cellule de tableau ne peut pas contenir de retour à la ligne.');
    }
    rows.push(cells);
  }

  let block: string;
  try {
    block = tableToMarkdown(rows);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Tableau invalide.');
  }

  let after: string;
  try {
    after = insertBlock(context.workingDoc, block, stringArg(args, 'article') || undefined);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Insertion impossible.');
  }

  return commitStructuredChange(context, context.workingDoc, after, {
    editsApplied: 1,
    summary: 'Tableau inséré',
    logEvent: 'tool_insert_table',
  });
}

async function insertList(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  if (!context.workingDoc) return fail('Aucun document à modifier : le Canvas est vide.');
  const items = Array.isArray(args.items) ? args.items.map((item) => String(item ?? '')) : [];
  let block: string;
  try {
    block = listToMarkdown(items, args.ordered === true, 1);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Liste invalide.');
  }

  let after: string;
  try {
    after = insertBlock(context.workingDoc, block, stringArg(args, 'article') || undefined);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Insertion impossible.');
  }

  return commitStructuredChange(context, context.workingDoc, after, {
    editsApplied: 1,
    summary: 'Liste insérée',
    logEvent: 'tool_insert_list',
  });
}

function signatureParties(value: unknown): SignatureParty[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? '').trim(),
      first_name: String(item.first_name ?? '').trim(),
      role: String(item.role ?? '').trim(),
      date: String(item.date ?? '').trim(),
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, 4);
}

async function insertSignature(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  if (!context.workingDoc) return fail('Aucun document à modifier : le Canvas est vide.');
  const parties = signatureParties(args.parties);
  if (parties.length === 0) {
    return fail('Indique au moins une partie avec son nom (bailleur, locataire, prestataire…).');
  }

  let after: string;
  try {
    after = insertSignatureBlock(
      context.workingDoc,
      parties,
      stringArg(args, 'intro') || undefined,
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Insertion du bloc de signatures impossible.');
  }

  return commitStructuredChange(context, context.workingDoc, after, {
    editsApplied: 1,
    summary: 'Bloc de signatures mis à jour',
    logEvent: 'tool_insert_signature_block',
  });
}

function computeDateTool(args: Record<string, unknown>, context: ToolContext): ToolResult {
  const result = computeDate({
    start: stringArg(args, 'start') || 'today',
    add: args.add && typeof args.add === 'object' ? args.add as Record<string, number> : {},
    inclusive: args.inclusive === true,
    now: context.now,
  });
  if (!result.ok) return fail(result.error);
  context.logger.info('tool_compute_date', { inclusive: result.value.inclusive });
  return ok(result.value);
}

function listPlaceholdersTool(_args: Record<string, unknown>, context: ToolContext): ToolResult {
  if (!context.workingDoc) return fail('Aucun document : le Canvas est vide.');
  const report = listPlaceholders(context.workingDoc);
  context.logger.info('tool_list_placeholders', { count: report.count });
  return ok(report);
}

function suggestNextActions(_args: Record<string, unknown>, context: ToolContext): ToolResult {
  const markdown = context.workingDoc ?? '';
  const report = listPlaceholders(markdown);
  const items = buildSuggestions({
    hasDocument: Boolean(markdown),
    placeholders: report.count,
    askedUser: false,
    markdown,
  });
  if (items.length > 0) context.emit('suggestions', { items });
  context.logger.info('tool_suggest_next_actions', { count: items.length });
  return {
    ...ok({ suggestions: items }),
    summary: `${items.length} action(s) proposée(s)`,
  };
}
