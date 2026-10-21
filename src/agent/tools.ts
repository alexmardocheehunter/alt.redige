/**
 * The three tools of the agent: their definition (sent to the model) and their
 * execution (server side). Everything a tool writes to the Canvas goes through
 * the `emit` callback, so the SSE contract stays in one place.
 */
import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { applyEdits, type Edit } from '../doc/edit.js';
import { validate } from '../doc/validate.js';
import type { Logger } from '../logger.js';
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
}

export interface ToolResult {
  /** JSON payload returned to the model. */
  content: string;
  isError: boolean;
}

/** Tool definitions sent to the model. */
export function toolDefinitions(templates: TemplateStore): Tool[] {
  const enumIds = templates.ready().map((template) => template.id);

  const tools: Tool[] = [
    {
      name: TOOL_GET_TEMPLATE,
      description:
        'Charge le modèle de référence d’un type de contrat : squelette Markdown, champs attendus et notes juridiques vérifiées. À appeler avant de rédiger.',
      input_schema: {
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
      input_schema: {
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
      input_schema: {
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

  // The tool list is stable across the turns: it can be cached by the provider.
  const last = tools[tools.length - 1];
  if (last) {
    (last as { cache_control?: { type: 'ephemeral' } }).cache_control = { type: 'ephemeral' };
  }

  return tools;
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
 * Executes a tool.
 * Returns the payload sent back to the model.
 */
export function executeTool(name: string, input: unknown, context: ToolContext): ToolResult {
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

function createCanvas(args: Record<string, unknown>, context: ToolContext): ToolResult {
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
  });

  return ok({
    ok: true,
    placeholders: validation.placeholders,
    issues: validation.issues,
    title,
    contract_type: contractType,
  });
}

function editCanvas(args: Record<string, unknown>, context: ToolContext): ToolResult {
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
  });

  return ok({
    ok: true,
    edits_applied: result.editsApplied,
    placeholders: validation.placeholders,
    issues: validation.issues,
  });
}
