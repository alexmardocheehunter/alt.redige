/**
 * TypeScript wrapper around the Markdown → Word converter.
 *
 * The converter itself (`export-docx.mjs`) comes from the reference folder and is
 * only extended, never rewritten.
 */
import { markdownToDocx } from './export-docx.mjs';

export interface DocxOptions {
  /** Optional text added under the page number in the footer. */
  footer?: string | null;
}

export interface DocxResult {
  buffer: Buffer;
  bytes: number;
}

/**
 * Converts a contract (restricted Markdown subset) into a `.docx` buffer.
 * @throws when the markdown is empty or the conversion fails.
 */
export async function renderDocx(markdown: string, options: DocxOptions = {}): Promise<DocxResult> {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    throw new Error('Le document est vide : rien à exporter.');
  }

  const footer = options.footer?.trim() ? options.footer.trim() : null;
  const buffer = await markdownToDocx(markdown, footer ? { footer } : {});

  return { buffer: buffer as Buffer, bytes: (buffer as Buffer).length };
}

/**
 * Builds an ASCII file name from a title.
 * Accents are removed, the result is lowercase and separated by dashes.
 */
export function slugify(title: string | null | undefined, fallback = 'contrat'): string {
  const source = (title ?? '').trim();
  if (!source) return fallback;

  const slug = source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
    .replace(/-+$/, '');

  return slug || fallback;
}

/**
 * Reads the title of the document (its `# ` heading), if any.
 */
export function titleFromMarkdown(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? match[1]!.trim() : null;
}

/** Content-Disposition header with an ASCII name and a UTF-8 variant. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
