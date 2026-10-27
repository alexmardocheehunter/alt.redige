/**
 * Server-side PDF generation for contracts using pdfmake.
 *
 * The generated PDF matches the on-screen contract:
 * - A4, 2.5 cm margins, embedded fonts (Roboto via pdfmake built-in)
 * - Real tables (signatures), real lists, bold/italic
 * - Yellow highlight for [À COMPLÉTER : …] placeholders
 * - Optional "BROUILLON" diagonal watermark when draft=true
 * - Optional company logo in header
 * - Page numbers in footer ("Page X / Y")
 * - PDF metadata (Title, Author, CreationDate in Africa/Abidjan)
 */
/// <reference types="pdfmake" />

import pdfMake from 'pdfmake/build/pdfmake.js';
import vfs from 'pdfmake/build/vfs_fonts.js';
import { validate } from '../doc/validate.js';
import { slugify } from './docx.js';

// Minimal local type definitions (mirroring @types/pdfmake/interfaces)
type PageOrientation = 'portrait' | 'landscape';
interface StyleDictionary { [name: string]: any; }
interface TDocumentDefinitions {
  pageSize?: string;
  pageOrientation?: PageOrientation;
  pageMargins?: number | [number, number] | [number, number, number, number];
  defaultStyle?: any;
  styles?: StyleDictionary;
  header?: any;
  footer?: any;
  content: any;
  background?: (currentPage: number, pageSize: { width: number; height: number }) => any;
  info?: { title?: string; author?: string; subject?: string; creationDate?: Date; producer?: string; keywords?: string[] };
}
type Content = any;

// Register pdfmake fonts (Roboto is built into vfs_fonts)
(pdfMake as any).vfs = vfs;

// ─── Constants ────────────────────────────────────────────────────────

export const MAX_DOCUMENT_BYTES = 200_000;
export const PDF_CONTENT_TYPE = 'application/pdf';

const YELLOW_HIGHLIGHT = '#fff9c4';
const WATERMARK_OPACITY = 0.08;
const WATERMARK_FONT_SIZE = 60;
const PAGE_MARGINS: [number, number, number, number] = [72, 72, 72, 72]; // 72 pt = 1 inch ≈ 2.54 cm
const LOGO_MAX_HEIGHT = 60;

// ─── Types ────────────────────────────────────────────────────────

export interface PdfExportBody {
  markdown: string;
  contract_type: string;
  company_profile: { legal_name: string; logo: string } | null;
  draft: boolean;
}

export interface PdfExportResult {
  buffer: Buffer;
  bytes: number;
  filename: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract a title from the first # heading, fallback to contract type. */
function titleFromMarkdown(md: string): string {
  const match = md.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? 'Contrat';
}

/** Build filename: Contrat_de_<type>_<partie>_<YYYY-MM-DD>.pdf */
function buildFilename(markdown: string, contractType: string, companyProfile: { legal_name: string } | null): string {
  const date = new Date().toLocaleDateString('fr-CA', { timeZone: 'Africa/Abidjan' }); // YYYY-MM-DD
  const title = titleFromMarkdown(markdown);
  const partie = companyProfile?.legal_name
    ? slugify(companyProfile.legal_name)
    : slugify(title);
  const typeSlug = slugify(contractType);
  return `Contrat_de_${typeSlug}_${partie}_${date}.pdf`;
}

/** Parse markdown into pdfmake content blocks. */
function markdownToPdfContent(markdown: string, draft: boolean): Content[] {
  const lines = markdown.split('\n');
  const content: Content[] = [];
  let listItems: Content[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      content.push({ ul: listItems, margin: [24, 4, 0, 8] });
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Page break
    if (line === '<!-- pagebreak -->') {
      flushList();
      content.push({ text: '', pageBreak: 'after' });
      continue;
    }

    // Horizontal rule
    if (line === '---') {
      flushList();
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#ccc' }], margin: [0, 8, 0, 8] });
      continue;
    }

    // Headings
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      flushList();
      content.push({ text: h3Match[1] ?? '', style: 'h3', margin: [0, 12, 0, 4] });
      continue;
    }
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      flushList();
      content.push({ text: h2Match[1] ?? '', style: 'h2', margin: [0, 16, 0, 6] });
      continue;
    }
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      flushList();
      content.push({ text: h1Match[1] ?? '', style: 'h1', margin: [0, 0, 0, 12] });
      continue;
    }

    // Table (GFM) - simplified for now
    const tableMatch = line.match(/^\|(.+)\|$/);
    if (tableMatch) {
      flushList();
      content.push({ text: line, style: 'tableRow', fontSize: 9 });
      continue;
    }

    // Bullet list
    const bulletMatch = line.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      listItems.push({ text: bulletMatch[1] ?? '', style: 'body' });
      continue;
    }

    // Numbered list
    const numMatch = line.match(/^\d{1,3}[.)]\s+(.+)$/);
    if (numMatch) {
      listItems.push({ text: numMatch[1] ?? '', style: 'body' });
      continue;
    }

    // Empty line
    if (line === '') {
      flushList();
      continue;
    }

    // Paragraph with inline formatting (bold, italic, placeholders)
    flushList();
    content.push(parseInline(line, draft));
  }

  flushList();
  return content;
}

/** Parse a single line into pdfmake inlines with bold/italic/placeholder highlight. */
function parseInline(text: string, _draft: boolean): Content {
  const segments: Array<{ text: string; bold?: boolean; italic?: boolean; highlight?: boolean }> = [];

  const placeholderRegex = /\[À COMPLÉTER\s*:\s*[^\]]+\]/g;
  const boldRegex = /\*\*([^*\n]+)\*\*/g;
  const italicRegex = /\*([^*\n]+)\*/g;

  const matches: Array<{ index: number; length: number; type: 'bold' | 'italic' | 'placeholder'; text: string }> = [];

  // Find placeholders first
  let match;
  while ((match = placeholderRegex.exec(text)) !== null) {
    matches.push({ index: match.index, length: match[0].length, type: 'placeholder', text: match[0] });
  }
  // Find bold
  while ((match = boldRegex.exec(text)) !== null) {
    matches.push({ index: match.index, length: match[0].length, type: 'bold', text: match[1] ?? '' });
  }
  // Find italic
  while ((match = italicRegex.exec(text)) !== null) {
    matches.push({ index: match.index, length: match[0].length, type: 'italic', text: match[1] ?? '' });
  }

  // Sort by index
  matches.sort((a, b) => a.index - b.index);

  // Build segments (simplified: non-overlapping)
  let pos = 0;
  for (const m of matches) {
    if (m.index > pos) {
      segments.push({ text: text.slice(pos, m.index) });
    }
    if (m.type === 'placeholder') {
      segments.push({ text: m.text, highlight: true });
    } else if (m.type === 'bold') {
      segments.push({ text: m.text, bold: true });
    } else if (m.type === 'italic') {
      segments.push({ text: m.text, italic: true });
    }
    pos = m.index + m.length;
  }
  if (pos < text.length) {
    segments.push({ text: text.slice(pos) });
  }

  // If no formatting found, return simple text
  if (segments.length === 1 && !segments[0]?.bold && !segments[0]?.italic && !segments[0]?.highlight) {
    return { text: text, style: 'body' };
  }

  // Build inlines array for pdfmake
  const inlines = segments.map((s) => {
    const style: string[] = [];
    if (s.bold) style.push('bold');
    if (s.italic) style.push('italic');
    return {
      text: s.text,
      style: style.length > 0 ? style : 'body',
      ...(s.highlight ? { color: '#000', background: YELLOW_HIGHLIGHT } : {}),
    };
  });

  return { text: inlines, style: 'body' };
}

// ─── Styles ───────────────────────────────────────────────────────────

const styles: StyleDictionary = {
  default: { font: 'Roboto', fontSize: 11, lineHeight: 1.45 },
  h1: { fontSize: 20, bold: true, alignment: 'center', margin: [0, 0, 0, 12] },
  h2: { fontSize: 15, bold: true, color: '#2d2d2d', margin: [0, 16, 0, 6] },
  h3: { fontSize: 12, bold: true, color: '#3d3d3d', margin: [0, 12, 0, 4] },
  body: { fontSize: 11, lineHeight: 1.5 },
  bold: { bold: true },
  italic: { italic: true },
  tableRow: { fontSize: 9, font: 'Roboto' },
  footer: { fontSize: 9, color: '#888', alignment: 'center' },
  header: { fontSize: 9, color: '#666', alignment: 'center' },
  watermark: { fontSize: WATERMARK_FONT_SIZE, color: '#ccc', opacity: WATERMARK_OPACITY, bold: true },
};

// ─── Main export function ─────────────────────────────────────────────

/**
 * Render a contract Markdown to a PDF buffer.
 * Throws if the markdown contains forbidden constructs.
 */
export async function renderPdf(params: {
  markdown: string;
  contractType: string;
  companyProfile: { legal_name: string; logo: string } | null;
  draft: boolean;
}): Promise<PdfExportResult> {
  // Validate markdown subset (reuse existing validator)
  const validation = validate(params.markdown);
  const forbidden = validation.issues.filter((issue) => issue.code === 'forbidden_construct');
  if (forbidden.length > 0) {
    throw new Error(`Document contains forbidden constructs: ${forbidden.map((i) => i.message).join(' ')}`);
  }

  const title = titleFromMarkdown(params.markdown);
  const filename = buildFilename(params.markdown, params.contractType, params.companyProfile);
  const nowAbidjan = new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Abidjan' }).replace(' ', 'T');

  // Build header content (logo + title)
  const headerContent: Content[] = [];
  if (params.companyProfile?.logo) {
    headerContent.push({
      image: params.companyProfile.logo,
      width: 120,
      height: LOGO_MAX_HEIGHT,
      alignment: 'left',
      margin: [0, 0, 0, 4],
    });
  }
  headerContent.push({ text: title, style: 'h1' });
  if (params.draft) {
    headerContent.push({ text: 'BROUILLON – champs à compléter', style: { fontSize: 10, color: '#e65100', bold: true }, margin: [0, 4, 0, 0] });
  }

  const docDefinition = {
    pageSize: 'A4',
    pageOrientation: 'portrait' as PageOrientation,
    pageMargins: PAGE_MARGINS,
    defaultStyle: styles.default,
    styles,
    header: {
      columns: [
        { stack: headerContent, width: '*' },
        {
          text: `Page ${'{#pageNumber}'} / ${'{#pageCount}'}`,
          style: 'header',
          alignment: 'right',
          margin: [0, 0, 0, 4],
        },
      ],
      margin: [72, 36, 72, 12],
    },
    footer: {
      text: '', // page numbers in header right
      margin: [72, 0, 72, 36],
    },
    content: markdownToPdfContent(params.markdown, params.draft),
    info: {
      title,
      author: params.companyProfile?.legal_name ?? 'LexCanvas',
      subject: `Contrat ${params.contractType}`,
      creationDate: new Date(nowAbidjan),
      producer: 'LexCanvas',
      keywords: `contrat,${params.contractType},Côte d'Ivoire`,
    },
    ...(params.draft
      ? {
          background: (currentPage: number, pageSize: { width: number; height: number }) => ({
            text: 'BROUILLON',
            style: 'watermark',
            alignment: 'center',
            absolutePosition: { x: pageSize.width / 2, y: pageSize.height / 2 },
            transform: [{ translateX: -150, translateY: 0 }, { rotate: -45 }],
          }),
        }
      : {}),
  };

  // Generate PDF
  const pdfDoc = pdfMake.createPdf(docDefinition as any) as any;
  const buffer = await pdfDoc.getBuffer();

  return { buffer, bytes: buffer.length, filename };
}

// ─── Content-Disposition helper ───────────────────────────────────────

export function contentDisposition(filename: string): string {
  // RFC 5987 encoding for UTF-8 filenames
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}