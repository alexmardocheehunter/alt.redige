/**
 * POST /api/export/docx — exports the contract as a Word file.
 *
 * The PDF export is done in the browser (`window.print()`): there is no PDF
 * endpoint in version 1.0.
 */
import { Hono } from 'hono';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { contentDisposition, renderDocx, slugify, titleFromMarkdown } from '../export/docx.js';
import type { Logger } from '../logger.js';
import type { AppEnv } from '../types.js';

export const MAX_DOCUMENT_BYTES = 200_000;
export const MAX_FOOTER_LENGTH = 200;

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ExportDeps {
  config: AppConfig;
  logger: Logger;
}

interface ExportBody {
  markdown: string;
  title: string | null;
  footer: string | null;
}

export function parseExportBody(raw: unknown, defaultFooter: string | null): ExportBody {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('bad_request', 'Corps de requête invalide.');
  }
  const body = raw as Record<string, unknown>;

  const markdown = body.markdown;
  if (typeof markdown !== 'string') {
    throw new AppError('bad_request', 'Le document à exporter est absent.');
  }
  if (markdown.trim().length === 0) {
    throw new AppError('bad_request', 'Le document à exporter est vide.');
  }
  if (Buffer.byteLength(markdown, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new AppError('payload_too_large', 'Le document est trop long pour être exporté.');
  }

  const rawTitle = body.title;
  if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== 'string') {
    throw new AppError('bad_request', 'Le titre est invalide.');
  }
  const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : null;

  const rawFooter = body.footer;
  if (rawFooter !== undefined && rawFooter !== null && typeof rawFooter !== 'string') {
    throw new AppError('bad_request', 'Le pied de page est invalide.');
  }
  if (typeof rawFooter === 'string' && rawFooter.length > MAX_FOOTER_LENGTH) {
    throw new AppError('bad_request', 'Le pied de page est trop long.');
  }

  // No footer in the request: fall back to the server default (if any).
  const footer = rawFooter === undefined ? defaultFooter : rawFooter;

  return { markdown, title, footer: footer && footer.length > 0 ? footer : null };
}

export function exportRoutes({ config, logger }: ExportDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/api/export/docx', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Corps de requête invalide.');
    }

    const body = parseExportBody(raw, config.exportFooter);
    const title = body.title ?? titleFromMarkdown(body.markdown);
    const filename = `${slugify(title)}.docx`;

    let result;
    try {
      result = await renderDocx(body.markdown, { footer: body.footer });
    } catch (error) {
      logger.error('export_failed', {
        request_id: c.get('requestId') ?? '-',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError('internal', 'L’export Word a échoué. Réessayez.');
    }

    logger.info('export_docx', {
      request_id: c.get('requestId') ?? '-',
      bytes: result.bytes,
      filename,
    });

    return c.body(result.buffer as unknown as ArrayBuffer, 200, {
      'Content-Type': DOCX_CONTENT_TYPE,
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(result.bytes),
      'Cache-Control': 'no-store',
    });
  });

  return app;
}
