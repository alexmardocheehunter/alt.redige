/**
 * Types describing a contract template (data/templates/*.json).
 * The shape mirrors reference/template.bail-habitation.example.json.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Types of contract requested by the user. */
export interface TemplateField {
  key: string;
  label: string;
  question_hint?: string;
}

export interface TemplateValidator {
  id: string;
  severity: 'info' | 'warning' | 'error';
  description: string;
  check?: unknown;
}

export interface ContractTemplate {
  id: string;
  label: string;
  description: string;
  status: 'ready' | 'draft';
  legal_review?: { status: string; reviewer: string | null; date: string | null };
  required_fields: TemplateField[];
  optional_fields: TemplateField[];
  required_articles: string[];
  /** Legal notes validated by a jurist. Empty in V1 — never invented. */
  legal_notes: string[];
  /** Machine-checkable legal rules. Empty in V1 — never invented. */
  validators: TemplateValidator[];
  skeleton_markdown: string;
  _comment_legal?: string;
}

export interface TemplateSummary {
  id: string;
  label: string;
  description: string;
  status: 'ready' | 'draft';
}

const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  question_hint: z.string().optional(),
});

const validatorSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  description: z.string(),
  check: z.unknown().optional(),
});

export const templateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  status: z.enum(['ready', 'draft']),
  legal_review: z
    .object({ status: z.string(), reviewer: z.string().nullable(), date: z.string().nullable() })
    .optional(),
  required_fields: z.array(fieldSchema).default([]),
  optional_fields: z.array(fieldSchema).default([]),
  required_articles: z.array(z.string()).default([]),
  legal_notes: z.array(z.string()).default([]),
  validators: z.array(validatorSchema).default([]),
  skeleton_markdown: z.string(),
  _comment_legal: z.string().optional(),
});

export const TEMPLATES_DIR = resolve(process.cwd(), 'data', 'templates');

export class TemplateLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateLoadError';
  }
}

/** Reads and validates every template of the directory. */
export function loadTemplates(directory: string = TEMPLATES_DIR): ContractTemplate[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch {
    throw new TemplateLoadError(`Répertoire de modèles introuvable : ${directory}`);
  }

  const templates: ContractTemplate[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const path = resolve(directory, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new TemplateLoadError(
        `Modèle illisible : ${file} — ${error instanceof Error ? error.message : 'JSON invalide'}`,
      );
    }
    const parsed = templateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TemplateLoadError(
        `Modèle invalide : ${file} — ${parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; ')}`,
      );
    }
    if (seen.has(parsed.data.id)) {
      throw new TemplateLoadError(`Identifiant de modèle en double : ${parsed.data.id}`);
    }
    seen.add(parsed.data.id);
    templates.push(parsed.data);
  }

  return templates;
}

export class TemplateStore {
  private readonly byIdMap: Map<string, ContractTemplate>;

  constructor(private readonly templates: ContractTemplate[]) {
    this.byIdMap = new Map(templates.map((template) => [template.id, template]));
  }

  static load(directory?: string): TemplateStore {
    return new TemplateStore(loadTemplates(directory));
  }

  all(): ContractTemplate[] {
    return [...this.templates];
  }

  ready(): ContractTemplate[] {
    return this.templates.filter((template) => template.status === 'ready');
  }

  get(id: string): ContractTemplate | undefined {
    return this.byIdMap.get(id);
  }

  has(id: string): boolean {
    return this.byIdMap.has(id);
  }

  /** Summaries sent to the frontend (GET /api/templates). */
  summaries(): TemplateSummary[] {
    return this.templates.map((template) => ({
      id: template.id,
      label: template.label,
      description: template.description,
      status: template.status,
    }));
  }

  /** The catalogue injected in the system prompt: `id — label — description`. */
  catalogue(): string {
    const lines = this.ready().map((template) => `- ${template.id} — ${template.label} — ${template.description}`);
    return lines.length > 0 ? lines.join('\n') : '- (aucun type de contrat disponible)';
  }
}
