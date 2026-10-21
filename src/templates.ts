/**
 * Types describing a contract template (data/templates/*.json).
 * The shape mirrors reference/template.bail-habitation.example.json.
 */

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
