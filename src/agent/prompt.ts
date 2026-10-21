/**
 * Assembly of the system prompt and of the contextual blocks sent to the model.
 *
 * The system prompt lives in `prompts/system.fr.md`; the `{{CATALOGUE}}` marker is
 * replaced by the list of the `ready` templates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TemplateStore } from '../templates.js';

export const SYSTEM_PROMPT_PATH = resolve(process.cwd(), 'prompts', 'system.fr.md');
export const CATALOGUE_MARKER = '{{CATALOGUE}}';

export interface DocumentPayload {
  markdown: string;
  version: number;
}

let cachedPrompt: string | null = null;

/** Reads the raw system prompt (without the catalogue). */
export function readSystemPromptFile(path: string = SYSTEM_PROMPT_PATH): string {
  if (!existsSync(path)) {
    throw new Error(`Prompt système introuvable : ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/** System prompt with the catalogue injected. */
export function buildSystemPrompt(store: TemplateStore, path: string = SYSTEM_PROMPT_PATH): string {
  if (!cachedPrompt) cachedPrompt = readSystemPromptFile(path);
  const catalogue = store.catalogue();
  if (!cachedPrompt.includes(CATALOGUE_MARKER)) {
    throw new Error(`Le prompt système ne contient pas le marqueur ${CATALOGUE_MARKER}.`);
  }
  return cachedPrompt.replace(CATALOGUE_MARKER, catalogue);
}

/** Clears the in-process cache (used by the tests). */
export function resetPromptCache(): void {
  cachedPrompt = null;
}

export interface UserContextInput {
  document: DocumentPayload | null;
  contractType: string | null;
  userText: string;
}

/**
 * Builds the last user message: the current document, then the request.
 * The document is data, never an instruction.
 */
export function buildUserContext({ document, contractType, userText }: UserContextInput): string {
  const parts: string[] = [];

  if (document && typeof document.markdown === 'string' && document.markdown.trim().length > 0) {
    parts.push(`<document_courant version="${document.version}">\n${document.markdown}\n</document_courant>`);
  } else {
    parts.push('<document_courant>(aucun document)</document_courant>');
  }

  if (contractType) {
    parts.push(`Type choisi par l'utilisateur : ${contractType}`);
  }

  parts.push(userText);
  return parts.join('\n\n');
}
