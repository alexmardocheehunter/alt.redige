/**
 * The three tools of the agent: their definition (sent to the model) and their
 * execution (server side). Everything a tool writes to the Canvas goes through
 * the `emit` callback, so the SSE contract stays in one place.
 */
import { applyEdits, type Edit } from '../doc/edit.js';
import { validate } from '../doc/validate.js';
import { lostArticles, countChangedBlocks } from '../doc/structure.js';
import { informedRequiredFields } from '../doc/required-fields.js';
import { checkReferences } from '../doc/references.js';
import { checkFacts } from '../doc/facts.js';
import type { Issue } from '../doc/validate.js';
import type { LlmClient, LlmToolDefinition } from '../llm.js';
import type { Logger } from '../logger.js';
import { checkTextSafety, looksLikeContract, shouldBlock } from '../safety.js';
import type { ContractTemplate, TemplateStore } from '../templates.js';
import type { AgentEmit, AskUserPayload, QuestionField, QuestionOption } from './events.js';

export const TOOL_GET_TEMPLATE = 'get_template';
export const TOOL_CREATE_CANVAS = 'create_canvas';
export const TOOL_EDIT_CANVAS = 'edit_canvas';

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
  /**
   * Nombre maximal de blocs qu'une modification ciblée a le droit de
   * toucher. Au-delà, la modification est refusée (garde-fou P0-2).
   */
  maxEditChangedBlocks: number;
  /** Compteur des questions posées dans ce tour (identifiants uniques). */
  askUserCounter: number;
  signal: AbortSignal;
}

export interface ToolResult {
  /** JSON payload returned to the model. */
  content: string;
  isError: boolean;
  /** `true` si l'outil a effectivement émis un `canvas_set`. */
  emittedCanvasSet?: boolean;
  /** `true` si l'outil a posé une question : le tour s'arrête sur `awaiting_input`. */
  askedUser?: boolean;
}

export const TOOL_ASK_USER = 'ask_user';

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
  ];
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
    case TOOL_ASK_USER:
      return askUser(args, context);
    default:
      return fail(`Outil inconnu : ${name}.`);
  }
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
  return ok(templatePayload(template));
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
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
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
    validation: { placeholders: validation.placeholders, issues: validation.issues },
  });

  context.logger.info('tool_create_canvas', {
    contract_type: contractType,
    placeholders: validation.placeholders,
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
  };
}
