/**
 * The three tools of the agent: their definition (sent to the model) and their
 * execution (server side). Everything a tool writes to the Canvas goes through
 * the `emit` callback, so the SSE contract stays in one place.
 */
import { applyEdits, type Edit } from '../doc/edit.js';
import { validate } from '../doc/validate.js';
import type { LlmClient, LlmToolDefinition } from '../llm.js';
import type { Logger } from '../logger.js';
import { checkTextSafety, looksLikeContract, shouldBlock } from '../safety.js';
import type { ContractTemplate, TemplateStore } from '../templates.js';
import type { AgentEmit } from './events.js';

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
  signal: AbortSignal;
}

export interface ToolResult {
  /** JSON payload returned to the model. */
  content: string;
  isError: boolean;
}

/** Tool definitions sent to the model (format OpenAI / OpenRouter). */
export function toolDefinitions(templates: TemplateStore): LlmToolDefinition[] {
  const enumIds = templates.ready().map((template) => template.id);

  return [
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
    default:
      return fail(`Outil inconnu : ${name}.`);
  }
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

async function createCanvas(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const contractType = typeof args.contract_type === 'string' ? args.contract_type.trim() : '';
  const markdown = typeof args.markdown === 'string' ? args.markdown : '';
  const replace = args.replace === true;

  if (!markdown.trim()) {
    return fail('Le contrat est vide : rien à écrire dans le Canvas.');
  }

  if (context.workingDoc !== null && !replace) {
    return fail(
      'Un document existe déjà dans le Canvas. Utilise edit_canvas pour le modifier, ou create_canvas avec replace=true pour tout recommencer.',
    );
  }

  const safety = await documentIsSafe(context, markdown);
  if (!safety.safe) {
    context.logger.warn('safety_blocked_document', { contract_type: contractType });
    return fail(
      'Le contenu rédigé a été bloqué par le filtre de sécurité. Ne le réécris pas tel quel : explique à l’utilisateur que sa demande ne peut pas être traitée.',
    );
  }

  const template = context.templates.get(contractType) ?? null;
  const validation = validate(markdown, template);

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

  return ok({
    ok: true,
    placeholders: validation.placeholders,
    issues: validation.issues,
    title,
    contract_type: contractType,
  });
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

  const safety = await documentIsSafe(context, result.markdown);
  if (!safety.safe) {
    context.logger.warn('safety_blocked_document', { mode: 'edit' });
    return fail(
      'La modification a été bloquée par le filtre de sécurité. Ne la réécris pas tel quelle : explique à l’utilisateur que sa demande ne peut pas être traitée.',
    );
  }

  const template = context.workingDocType ? context.templates.get(context.workingDocType) ?? null : null;
  const validation = validate(result.markdown, template);

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
  });

  return ok({
    ok: true,
    edits_applied: result.editsApplied,
    placeholders: validation.placeholders,
    issues: validation.issues,
  });
}
