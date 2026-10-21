/**
 * Types of the Markdown → Word converter (reference/export-docx.mjs, extended).
 */

export interface DocxConverterOptions {
  /** Optional text added under the page number in the footer. */
  footer?: string;
}

export declare function markdownToDocx(
  markdown: string,
  options?: DocxConverterOptions,
): Promise<Buffer>;
