/**
 * POST /api/export/docx — exports the contract as a Word file.
 * POST /api/export/pdf  — exports the contract as a PDF file (server-side, pdfmake).
 */
import { Hono } from 'hono';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { contentDisposition, renderDocx, slugify, titleFromMarkdown } from '../export/docx.js';
import { renderPdf, contentDisposition as pdfContentDisposition, type PdfExportBody } from '../export/pdf.js';
import { validate } from '../doc/validate.js';
import type { Logger } from '../logger.js';
import type { AppEnv } from '../types.js';

export const MAX_DOCUMENT_BYTES = 200_000;
export const MAX_FOOTER_LENGTH = 200;

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_CONTENT_TYPE = 'application/pdf';

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

    // Le document exporté doit être conforme au sous-ensemble Markdown : le
    // convertisseur Word ignore silencieusement ce qu'il ne sait pas traiter
    // (blocs de code, images, URL de liens). On refuse l'export plutôt que
    // de livrer un fichier différent du contrat affiché.
    const validation = validate(body.markdown);
    const forbidden = validation.issues.filter((issue) => issue.code === 'forbidden_construct');
    if (forbidden.length > 0) {
      logger.warn('export_refused', {
        request_id: c.get('requestId') ?? '-',
        issues: forbidden.length,
      });
      throw new AppError(
        'bad_request',
        `Le document contient des éléments qui ne peuvent pas être exportés en Word : ${forbidden.map((issue) => issue.message).join(' ')} Corrigez le document avant de l'exporter.`,
      );
    }

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

  // ─── PDF export ─────────────────────────────────────────────────────
  app.post('/api/export/pdf', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Corps de requête invalide.');
    }

    if (!raw || typeof raw !== 'object') {
      throw new AppError('bad_request', 'Corps de requête invalide.');
    }
    const body = raw as Record<string, unknown>;

    const markdown = body.markdown;
    if (typeof markdown !== 'string' || markdown.trim().length === 0) {
      throw new AppError('bad_request', 'Le document à exporter est absent ou vide.');
    }
    if (Buffer.byteLength(markdown, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new AppError('payload_too_large', 'Le document est trop long pour être exporté.');
    }

    const contractType = body.contract_type;
    if (typeof contractType !== 'string' || contractType.trim().length === 0) {
      throw new AppError('bad_request', 'Le type de contrat est requis.');
    }

    const companyProfileRaw = body.company_profile;
    let companyProfile: { legal_name: string; logo: string } | null = null;
    if (companyProfileRaw && typeof companyProfileRaw === 'object') {
      const cp = companyProfileRaw as Record<string, unknown>;
      const legalName = typeof cp.legal_name === 'string' ? cp.legal_name.trim() : '';
      const logo = typeof cp.logo === 'string' ? cp.logo.trim() : '';
      if (legalName || logo) {
        companyProfile = { legal_name: legalName, logo };
      }
    }

    const draft = body.draft === true;

    // Validate markdown subset
    const validation = validate(markdown);
    const forbidden = validation.issues.filter((issue) => issue.code === 'forbidden_construct');
    if (forbidden.length > 0) {
      logger.warn('export_pdf_refused', {
        request_id: c.get('requestId') ?? '-',
        issues: forbidden.length,
      });
      throw new AppError(
        'bad_request',
        `Le document contient des éléments qui ne peuvent pas être exportés en PDF : ${forbidden.map((issue) => issue.message).join(' ')} Corrigez le document avant de l'exporter.`,
      );
    }

    let result;
    try {
      result = await renderPdf({ markdown, contractType, companyProfile, draft });
    } catch (error) {
      logger.error('export_pdf_failed', {
        request_id: c.get('requestId') ?? '-',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError('internal', "L'export PDF a échoué. Réessayez.");
    }

    logger.info('export_pdf', {
      request_id: c.get('requestId') ?? '-',
      bytes: result.bytes,
      filename: result.filename,
      draft,
    });

    return c.body(result.buffer as unknown as ArrayBuffer, 200, {
      'Content-Type': PDF_CONTENT_TYPE,
      'Content-Disposition': pdfContentDisposition(result.filename),
      'Content-Length': String(result.bytes),
      'Cache-Control': 'no-store',
    });
  });

  return app;
}
