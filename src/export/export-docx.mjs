// lib/export-docx.mjs — Markdown (sous-ensemble contrat) -> .docx
// Sous-ensemble supporté : # titre, ##/### articles, paragraphes, **gras**, *italique*,
// listes numérotées (alinéas), listes à puces, tableaux (signatures), ---, <!-- pagebreak -->,
// et [À COMPLÉTER : ...] surligné en jaune.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';

const require = createRequire(import.meta.url);
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow,
  TableCell, WidthType, BorderStyle, ShadingType, HeightRule, Footer, PageNumber, LevelFormat, PageBreak,
} = require('docx');

const FONT = 'Times New Roman';
const CONTENT_WIDTH = 9026; // A4 (11906) - marges 2 x 1440, en DXA
const PLACEHOLDER = /(\[À COMPLÉTER[^\]]*\])/g;

let orderedInstance = 0; // une instance de numérotation par liste => redémarre à 1

// ---------- Inline ----------
function inline(nodes, style = {}) {
  const runs = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      for (const part of n.value.split(PLACEHOLDER)) {
        if (!part) continue;
        const isPh = part.startsWith('[À COMPLÉTER');
        runs.push(new TextRun({ text: part, font: FONT, ...style, ...(isPh ? { shading: { type: ShadingType.CLEAR, fill: 'FFF200', color: 'auto' }, bold: true } : {}) }));
      }
    } else if (n.type === 'strong') runs.push(...inline(n.children, { ...style, bold: true }));
    else if (n.type === 'emphasis') runs.push(...inline(n.children, { ...style, italics: true }));
    else if (n.type === 'break') runs.push(new TextRun({ break: 1 }));
    else if (n.type === 'inlineCode') runs.push(new TextRun({ text: n.value, font: FONT, ...style }));
    else if (n.children) runs.push(...inline(n.children, style));
  }
  return runs;
}

// ---------- Blocs ----------
const HEADINGS = {
  1: { level: HeadingLevel.HEADING_1, align: AlignmentType.CENTER },
  2: { level: HeadingLevel.HEADING_2, align: AlignmentType.LEFT },
  3: { level: HeadingLevel.HEADING_3, align: AlignmentType.LEFT },
};

function block(node, listCtx) {
  switch (node.type) {
    case 'heading': {
      const h = HEADINGS[Math.min(node.depth, 3)];
      return [new Paragraph({ heading: h.level, alignment: h.align, keepNext: true, children: inline(node.children) })];
    }
    case 'paragraph':
      return [new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children: inline(node.children) })];
    case 'list': {
      const instance = node.ordered ? ++orderedInstance : 0;
      const level = listCtx ? 1 : 0;
      const out = [];
      for (const item of node.children) {
        for (const child of item.children) {
          if (child.type === 'paragraph') {
            out.push(new Paragraph({
              alignment: AlignmentType.JUSTIFIED,
              spacing: { after: 80 },
              numbering: node.ordered
                ? { reference: 'ordered', level, instance }
                : { reference: 'bullets', level },
              children: inline(child.children),
            }));
          } else out.push(...block(child, { nested: true }));
        }
      }
      return out;
    }
    case 'table': return [table(node), new Paragraph({ spacing: { after: 120 }, children: [] })];
    case 'thematicBreak':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } }, spacing: { after: 120 }, children: [] })];
    case 'html':
      return /pagebreak/i.test(node.value) ? [new Paragraph({ children: [new PageBreak()] })] : [];
    case 'blockquote':
      return node.children.flatMap((c) => c.type === 'paragraph'
        ? [new Paragraph({ indent: { left: 567 }, spacing: { after: 120 }, children: inline(c.children, { italics: true }) })]
        : block(c));
    default:
      return [];
  }
}

function table(node) {
  const cols = node.children[0].children.length;
  const w = Math.floor(CONTENT_WIDTH / cols);
  const widths = Array.from({ length: cols }, (_, i) => (i === cols - 1 ? CONTENT_WIDTH - w * (cols - 1) : w));
  const line = { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' };
  const borders = { top: line, bottom: line, left: line, right: line };
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: node.children.map((row, r) => new TableRow({
      cantSplit: true,
      ...(row.children.every((c) => c.children.length === 0) ? { height: { value: 1100, rule: HeightRule.ATLEAST } } : {}),
      children: row.children.map((cell, c) => new TableCell({
        width: { size: widths[c], type: WidthType.DXA },
        borders,
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: inline(cell.children, r === 0 ? { bold: true } : {}) })],
      })),
    })),
  });
}

// ---------- Document ----------
const indentFor = (level) => ({ left: 567 + level * 567, hanging: 360 });

export async function markdownToDocx(markdown, options = {}) {
  const { footer } = options;
  orderedInstance = 0;
  const tree = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const children = tree.children.flatMap((n) => block(n));

  const doc = new Document({
    creator: 'LexCanvas',
    styles: {
      default: { document: { run: { font: FONT, size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT, size: 30, bold: true, allCaps: true }, paragraph: { spacing: { before: 120, after: 360 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT, size: 24, bold: true }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: FONT, size: 22, bold: true, italics: true }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [
        { reference: 'ordered', levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: indentFor(0) } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2)', alignment: AlignmentType.LEFT, style: { paragraph: { indent: indentFor(1) } } },
        ] },
        { reference: 'bullets', levels: [
          { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: indentFor(0) } } },
          { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: indentFor(1) } } },
        ] },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: { default: new Footer({ children: [
        new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES], font: FONT, size: 18 })] }),
        ...(footer ? [new Paragraph({ alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: footer, font: FONT, size: 18 })] })] : []),
      ] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

// ---------- CLI : node export-docx.mjs in.md out.docx ----------
if (process.argv[1] && process.argv[1].endsWith('export-docx.mjs') && process.argv[2]) {
  const buf = await markdownToDocx(readFileSync(process.argv[2], 'utf8'));
  writeFileSync(process.argv[3] ?? 'out.docx', buf);
  console.log('OK ->', process.argv[3] ?? 'out.docx', buf.length, 'octets');
}
