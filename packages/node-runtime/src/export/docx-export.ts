import * as path from 'path';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { writeFileAtomically } from '../filesystem/file-write';
import { downloadRemoteImage, isAllowedImageUrl, MAX_IMAGE_BYTES } from '../image/remote-image';
import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document as DocxDocument,
  FileChild,
  ISectionOptions,
  HeadingLevel,
  ImageRun,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  SectionType,
  TableRow,
  TextRun,
  WidthType,
  Packer,
} from 'docx';

type DocxImageType = 'jpg' | 'png' | 'gif' | 'bmp';

function inferDocxImageTypeByPath(imagePath: string): DocxImageType | null {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  return null;
}

function inferDocxImageTypeByBytes(data: Uint8Array): DocxImageType | null {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47
    && data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A) {
    return 'png';
  }
  if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    return 'jpg';
  }
  if (data.length >= 6) {
    const h = String.fromCharCode(data[0], data[1], data[2], data[3], data[4], data[5]);
    if (h === 'GIF87a' || h === 'GIF89a') return 'gif';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4D) {
    return 'bmp';
  }
  return null;
}

function parseMarkdownImageTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  if (!target) return '';
  if (target.startsWith('<') && target.endsWith('>')) {
    return target.slice(1, -1).trim();
  }
  const titleStart = target.match(/\s+["'][^"']*["']\s*$/);
  if (titleStart) {
    return target.slice(0, titleStart.index).trim();
  }
  return target;
}

async function resolveDocxImageData(
  imageSrcRaw: string,
  docDir: string,
  allowExternalLocalImages: boolean,
): Promise<{ data: Buffer; type: DocxImageType } | null> {
  const imageSrc = imageSrcRaw.trim();
  if (!imageSrc) return null;

  if (imageSrc.startsWith('data:image/')) {
    const match = imageSrc.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;
    const base64 = match[2].replace(/\s+/g, '');
    const data = Buffer.from(base64, 'base64');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return null;
    const mimeSubtype = match[1].toLowerCase();
    const typeMap: Record<string, DocxImageType> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' };
    const type = typeMap[mimeSubtype] ?? inferDocxImageTypeByBytes(data);
    return type ? { data, type } : null;
  }

  if (/^https?:\/\//i.test(imageSrc)) {
    if (!isAllowedImageUrl(imageSrc)) return null;
    const data = await downloadRemoteImage(imageSrc);
    const type = inferDocxImageTypeByPath(imageSrc) ?? inferDocxImageTypeByBytes(data);
    return type ? { data, type } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(imageSrc) && !path.isAbsolute(imageSrc)) return null;

  let decoded = imageSrc;
  try { decoded = decodeURIComponent(imageSrc); } catch { decoded = imageSrc; }
  const root = await realpath(docDir);
  const candidate = path.isAbsolute(decoded) ? decoded : path.resolve(root, decoded);
  const resolvedPath = await realpath(candidate);
  if (!allowExternalLocalImages) {
    const resolvedRelative = path.relative(root, resolvedPath);
    if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) return null;
  }
  const info = await stat(resolvedPath);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
  const data = Buffer.from(await readFile(resolvedPath));
  const type = inferDocxImageTypeByPath(resolvedPath) ?? inferDocxImageTypeByBytes(data);
  return type ? { data, type } : null;
}

function getImageDimensions(type: DocxImageType, data: Buffer): { width: number; height: number } | null {
  try {
    if (type === 'png' && data.length >= 24) {
      return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
      };
    }
    if (type === 'gif' && data.length >= 10) {
      return {
        width: data.readUInt16LE(6),
        height: data.readUInt16LE(8),
      };
    }
    if (type === 'bmp' && data.length >= 26) {
      return {
        width: Math.abs(data.readInt32LE(18)),
        height: Math.abs(data.readInt32LE(22)),
      };
    }
    if (type === 'jpg') {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xFF) {
          offset++;
          continue;
        }
        const marker = data[offset + 1];
        offset += 2;
        if (marker === 0xD8 || marker === 0xD9) continue;
        if (offset + 1 >= data.length) break;
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) break;
        const isSofMarker =
          (marker >= 0xC0 && marker <= 0xC3)
          || (marker >= 0xC5 && marker <= 0xC7)
          || (marker >= 0xC9 && marker <= 0xCB)
          || (marker >= 0xCD && marker <= 0xCF);
        if (isSofMarker && length >= 7) {
          return {
            height: data.readUInt16BE(offset + 3),
            width: data.readUInt16BE(offset + 5),
          };
        }
        offset += length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function fitImageIntoBounds(
  width: number,
  height: number,
  maxWidth = 640,
  maxHeight = 420
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 520, height: 300 };
  }
  const widthRatio = maxWidth / width;
  const heightRatio = maxHeight / height;
  const ratio = Math.min(widthRatio, heightRatio, 1);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

const DOCX_PAGE_MM = { width: 210, height: 297, margin: 20 };
const DOCX_PX_PER_MM = 96 / 25.4;
const DOCX_PORTRAIT_CONTENT_TWIP = convertMillimetersToTwip(DOCX_PAGE_MM.width - DOCX_PAGE_MM.margin * 2);
const DOCX_LANDSCAPE_CONTENT_TWIP = convertMillimetersToTwip(DOCX_PAGE_MM.height - DOCX_PAGE_MM.margin * 2);
/** Prefer a slightly tighter table than full content width so borders stay inside margins. */
const DOCX_PORTRAIT_TABLE_WIDTH = Math.min(9360, DOCX_PORTRAIT_CONTENT_TWIP);
const DOCX_LANDSCAPE_TABLE_WIDTH = Math.min(14570, DOCX_LANDSCAPE_CONTENT_TWIP);
/** Approx. 11pt glyph widths in twips (CJK full-width vs. Latin). */
const DOCX_CHAR_TWIP_CJK = 168;
const DOCX_CHAR_TWIP_LATIN = 90;
const DOCX_TABLE_CELL_PAD_TWIP = 160;
const DOCX_TABLE_BORDER_TWIP = 20;

type DocxPageOrientation = 'portrait' | 'landscape';

/** Tables that need more than portrait content width get their own landscape section. */
const docxWideTables = new WeakSet<Table>();

function createDocxSection(children: FileChild[], orientation: DocxPageOrientation): ISectionOptions {
  const isLandscape = orientation === 'landscape';
  return {
    properties: {
      type: SectionType.NEXT_PAGE,
      page: {
        size: {
          // docx swaps width and height when serializing a landscape page.
          width: convertMillimetersToTwip(DOCX_PAGE_MM.width),
          height: convertMillimetersToTwip(DOCX_PAGE_MM.height),
          orientation: isLandscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
        },
        margin: {
          top: convertMillimetersToTwip(DOCX_PAGE_MM.margin),
          right: convertMillimetersToTwip(DOCX_PAGE_MM.margin),
          bottom: convertMillimetersToTwip(DOCX_PAGE_MM.margin),
          left: convertMillimetersToTwip(DOCX_PAGE_MM.margin),
        },
      },
    },
    children,
  };
}

/**
 * Place only over-wide tables in their own landscape section.
 * Narrow tables stay in the surrounding portrait flow (no forced page break).
 */
function createDocxSections(children: FileChild[]): ISectionOptions[] {
  const sections: ISectionOptions[] = [];
  let portraitChildren: FileChild[] = [];

  const flushPortrait = () => {
    if (portraitChildren.length === 0) return;
    sections.push(createDocxSection(portraitChildren, 'portrait'));
    portraitChildren = [];
  };

  for (const child of children) {
    if (child instanceof Table && docxWideTables.has(child)) {
      flushPortrait();
      sections.push(createDocxSection([child], 'landscape'));
    } else {
      portraitChildren.push(child);
    }
  }
  flushPortrait();

  return sections.length > 0
    ? sections
    : [createDocxSection([new Paragraph({ children: [] })], 'portrait')];
}

function estimateDocxTextWidthTwip(text: string): number {
  let maxLine = 0;
  let line = 0;
  for (const char of text) {
    if (char === '\n' || char === '\r') {
      maxLine = Math.max(maxLine, line);
      line = 0;
      continue;
    }
    // CJK / full-width glyphs are roughly square at body size.
    if (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF]/.test(char)) {
      line += DOCX_CHAR_TWIP_CJK;
    } else {
      line += DOCX_CHAR_TWIP_LATIN;
    }
  }
  return Math.max(maxLine, line);
}

function estimateDocxTableWidthTwip(header: string[], body: string[][]): number {
  const columnCount = Math.max(header.length, ...body.map((row) => row.length), 1);
  const colWidths = Array.from({ length: columnCount }, () => 800);
  const rows = [header, ...body];
  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      colWidths[i] = Math.max(colWidths[i], estimateDocxTextWidthTwip(row[i] ?? '') + DOCX_TABLE_CELL_PAD_TWIP);
    }
  }
  return colWidths.reduce((sum, width) => sum + width, 0) + (columnCount + 1) * DOCX_TABLE_BORDER_TWIP;
}

function docxTableNeedsLandscape(header: string[], body: string[][]): boolean {
  const columnCount = Math.max(header.length, ...body.map((row) => row.length), 1);
  // Narrow tables (under 5 columns) stay portrait even when cells are text-heavy.
  if (columnCount < 5) return false;
  return estimateDocxTableWidthTwip(header, body) > DOCX_PORTRAIT_CONTENT_TWIP;
}

function docxContentSizePx(): { width: number; height: number } {
  return {
    width: Math.floor((DOCX_PAGE_MM.width - DOCX_PAGE_MM.margin * 2) * DOCX_PX_PER_MM),
    height: Math.floor((DOCX_PAGE_MM.height - DOCX_PAGE_MM.margin * 2) * DOCX_PX_PER_MM),
  };
}

function fitMermaidToDocxPage(width: number, height: number, pngData?: Buffer): { width: number; height: number } {
  let w = width;
  let h = height;
  const ihdr = pngData ? getImageDimensions('png', pngData) : null;
  if (ihdr && ihdr.width > 0 && ihdr.height > 0) {
    w = ihdr.width;
    h = ihdr.height;
  }
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { width: 580, height: 240 };
  }
  const page = docxContentSizePx();
  const maxW = Math.max(320, Math.floor(page.width * 0.96));
  const maxH = Math.max(240, Math.floor(page.height * 0.88));
  const scale = Math.min(maxW / w, maxH / h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function markdownInlineToDocxRuns(value: string, defaults: Record<string, unknown> = {}): TextRun[] {
  const runs: TextRun[] = [];
  const tokenRe = /(\*\*|__)(.+?)\1|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\([^)]+\)|(\*|_)(.+?)\7/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const append = (text: string, options: Record<string, unknown> = {}) => {
    if (text) runs.push(new TextRun({ text, ...defaults, ...options }));
  };

  while ((match = tokenRe.exec(value)) !== null) {
    append(value.slice(cursor, match.index));
    if (match[1]) append(match[2], { bold: true });
    else if (match[3]) append(match[3], { strike: true });
    else if (match[4]) append(match[4], { font: 'Courier New', shading: { fill: 'EEF1F4' } });
    else if (match[5]) append(match[5], { color: '0563C1', underline: {} });
    else append(match[8], { italics: true });
    cursor = match.index + match[0].length;
  }
  append(value.slice(cursor));
  return runs.length > 0 ? runs : [new TextRun({ text: '', ...defaults })];
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseMarkdownTableAlignments(separator: string[]): ('left' | 'center' | 'right')[] | null {
  const alignments: ('left' | 'center' | 'right')[] = [];
  for (const cell of separator) {
    const value = cell.trim().replace(/\s+/g, '');
    if (!/^:?-{3,}:?$/.test(value)) return null;
    alignments.push(value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : 'left');
  }
  return alignments.length > 0 ? alignments : null;
}

function isMarkdownListLine(line: string): boolean {
  return /^(?:[-*+]|\d+[.)])\s+/.test(line.trim());
}

function isEmptyMarkdownHeadingLine(line: string): boolean {
  return /^#{1,6}\s*$/.test(line.trim());
}

/** Ignore pipes that are mentioned as text, e.g. 用“|”分割. */
function stripQuotedMarkdownPipes(line: string): string {
  return line.replace(/[“”«»「」『』"'‘’]\|[“”«»「」『』"'‘’]/g, '');
}

function isMarkdownTableSeparatorLine(line: string): boolean {
  const cells = splitMarkdownTableRow(stripQuotedMarkdownPipes(line.trim()));
  return parseMarkdownTableAlignments(cells) !== null;
}

function isMarkdownPipeRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  if (trimmed.startsWith('```')) return false;
  if (/^<!--/.test(trimmed)) return false;
  if (/^<\/?(table|thead|tbody|tfoot|tr|td|th)\b/i.test(trimmed)) return false;
  if (isMarkdownListLine(trimmed) || isEmptyMarkdownHeadingLine(trimmed)) return false;
  if (/^#{1,6}\s/.test(trimmed)) return false;
  const normalized = stripQuotedMarkdownPipes(trimmed);
  if (!normalized.includes('|')) return false;
  if (isMarkdownTableSeparatorLine(normalized)) return true;
  return splitMarkdownTableRow(normalized).length >= 2
    && (normalized.startsWith('|') || normalized.endsWith('|') || /\s\|\s/.test(normalized));
}

function isMarkdownTableStart(current: string, next: string): boolean {
  if (!isMarkdownPipeRow(current) || !next.trim()) return false;
  if (isMarkdownTableSeparatorLine(next)) return true;
  if (!isMarkdownPipeRow(next)) return false;
  return current.trim().startsWith('|') && next.trim().startsWith('|');
}

const DOCX_TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'C8CDD4' } as const;
const DOCX_NOTICE_STYLES: Record<string, { border: string; fill: string; title: string }> = {
  note: { border: '0969DA', fill: 'DDF4FF', title: 'Note' },
  tip: { border: '1A7F37', fill: 'DAFBE1', title: 'Tip' },
  important: { border: '8250DF', fill: 'FBEFFF', title: 'Important' },
  caution: { border: '9A6700', fill: 'FFF8C5', title: 'Caution' },
  warning: { border: 'CF222E', fill: 'FFEBE9', title: 'Warning' },
};

async function markdownFragmentToDocxParagraphs(
  value: string,
  docDir: string,
  options: { bold?: boolean; color?: string; alignment?: typeof AlignmentType[keyof typeof AlignmentType] } = {},
  allowExternalLocalImages = false,
): Promise<Paragraph[]> {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  const paragraphs: Paragraph[] = [];
  const alignment = options.alignment ?? AlignmentType.LEFT;
  const runDefaults: Record<string, unknown> = {};
  if (options.bold) runDefaults.bold = true;
  if (options.color) runDefaults.color = options.color;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim() && paragraphs.length === 0) continue;
    const imageMatches = [...line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)(?:\s*\{[^}]+\})?/g)];
    const children: (TextRun | ImageRun)[] = [];
    if (imageMatches.length === 0) {
      children.push(...markdownInlineToDocxRuns(line.trim() ? line.trim() : ' ', runDefaults));
    } else {
      let cursor = 0;
      for (const match of imageMatches) {
        const matchText = match[0];
        const altText = (match[1] ?? '').trim();
        const imageSrc = parseMarkdownImageTarget(match[2] ?? '');
        const start = match.index ?? 0;
        const before = line.slice(cursor, start);
        if (before.trim()) children.push(...markdownInlineToDocxRuns(before, runDefaults));
        try {
          const imageResolved = await resolveDocxImageData(imageSrc, docDir, allowExternalLocalImages);
          if (imageResolved) {
            const dimensions = getImageDimensions(imageResolved.type, imageResolved.data);
            const fitted = fitImageIntoBounds(dimensions?.width ?? 520, dimensions?.height ?? 300, 320, 240);
            children.push(new ImageRun({ type: imageResolved.type, data: imageResolved.data, transformation: fitted }));
          } else {
            children.push(new TextRun(`[Image: ${altText || imageSrc}]`));
          }
        } catch {
          children.push(new TextRun(`[Image: ${altText || imageSrc}]`));
        }
        cursor = start + matchText.length;
      }
      const after = line.slice(cursor);
      if (after.trim()) children.push(...markdownInlineToDocxRuns(after, runDefaults));
    }
    paragraphs.push(new Paragraph({
      alignment,
      spacing: { before: 0, after: 0, line: 276 },
      children: children.length > 0 ? children : [new TextRun({ text: '', ...runDefaults })],
    }));
  }

  return paragraphs.length > 0
    ? paragraphs
    : [new Paragraph({ alignment, spacing: { before: 0, after: 0 }, children: [new TextRun({ text: '', ...runDefaults })] })];
}

async function createDocxTable(
  header: string[],
  body: string[][],
  alignments: ('left' | 'center' | 'right')[],
  docDir: string,
  headerIsHeader = true,
  allowExternalLocalImages = false,
): Promise<Table> {
  const columnCount = Math.max(header.length, ...body.map((row) => row.length), 1);
  const alignmentMap = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
  const needsLandscape = docxTableNeedsLandscape(header, body);
  const tableWidth = needsLandscape ? DOCX_LANDSCAPE_TABLE_WIDTH : DOCX_PORTRAIT_TABLE_WIDTH;
  const colWidth = Math.max(800, Math.floor(tableWidth / columnCount));
  const buildRow = async (cells: string[], isHeader: boolean, rowIndex: number) => new TableRow({
    cantSplit: true,
    children: await Promise.all(Array.from({ length: columnCount }, async (_, index) => new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      borders: { top: DOCX_TABLE_BORDER, bottom: DOCX_TABLE_BORDER, left: DOCX_TABLE_BORDER, right: DOCX_TABLE_BORDER },
      shading: { fill: isHeader ? 'EEF2F6' : rowIndex % 2 === 0 ? 'F8FAFC' : 'FFFFFF' },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: await markdownFragmentToDocxParagraphs(
        cells[index] ?? '',
        docDir,
        {
          bold: isHeader,
          color: isHeader ? '1F2937' : '27303B',
          alignment: alignmentMap[alignments[index] ?? 'left'],
        },
        allowExternalLocalImages,
      ),
    }))),
  });

  const rows = [
    await buildRow(header, headerIsHeader, 0),
    ...(await Promise.all(body.map((row, index) => buildRow(row, false, index)))),
  ];

  const table = new Table({
    rows,
    width: { size: tableWidth, type: WidthType.DXA },
    columnWidths: Array.from({ length: columnCount }, () => colWidth),
    borders: {
      top: DOCX_TABLE_BORDER,
      bottom: DOCX_TABLE_BORDER,
      left: DOCX_TABLE_BORDER,
      right: DOCX_TABLE_BORDER,
      insideHorizontal: DOCX_TABLE_BORDER,
      insideVertical: DOCX_TABLE_BORDER,
    },
    layout: TableLayoutType.FIXED,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  if (needsLandscape) docxWideTables.add(table);
  return table;
}

function createDocxBlockquoteParagraph(content: string, isFirst: boolean, isLast: boolean, style?: { border: string; fill: string }): Paragraph {
  const border = style?.border ?? '8B9EB3';
  const fill = style?.fill ?? 'F4F7FA';
  return new Paragraph({
    indent: { left: 240, right: 120 },
    border: {
      left: { color: border, size: 12, space: 10, style: BorderStyle.SINGLE },
      top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    shading: { fill },
    spacing: { before: isFirst ? 80 : 0, after: isLast ? 80 : 0, line: 276 },
    alignment: AlignmentType.LEFT,
    children: markdownInlineToDocxRuns(content, { color: '334155' }),
  });
}

function findHtmlTagRange(
  html: string,
  from: number,
  tag: string
): { openStart: number; openEnd: number; closeStart: number; closeEnd: number } | null {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'ig');
  openRe.lastIndex = from;
  const open = openRe.exec(html);
  if (!open) return null;
  let depth = 1;
  const walker = new RegExp(`</?${tag}\\b[^>]*>`, 'ig');
  walker.lastIndex = open.index + open[0].length;
  let match: RegExpExecArray | null;
  while ((match = walker.exec(html))) {
    if (match[0][1] === '/') depth--;
    else depth++;
    if (depth === 0) {
      return {
        openStart: open.index,
        openEnd: open.index + open[0].length,
        closeStart: match.index,
        closeEnd: match.index + match[0].length,
      };
    }
  }
  return null;
}

function consumeHtmlTable(lines: string[], startIndex: number): { html: string; endIndex: number } | null {
  const joined = lines.slice(startIndex).join('\n');
  const start = joined.search(/<table[\s>]/i);
  if (start < 0) return null;
  const range = findHtmlTagRange(joined, start, 'table');
  if (!range) return null;
  const html = joined.slice(range.openStart, range.closeEnd);
  const consumedLineCount = joined.slice(0, range.closeEnd).split('\n').length;
  return { html, endIndex: startIndex + consumedLineCount - 1 };
}

function htmlCellToMarkdown(inner: string): string {
  return inner
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#124;/g, '|')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseHtmlTableRows(html: string): string[][] {
  const tableRange = findHtmlTagRange(html, 0, 'table');
  if (!tableRange) return [];
  const inner = html.slice(tableRange.openEnd, tableRange.closeStart);
  const rows: string[][] = [];
  let search = 0;
  while (search < inner.length) {
    const tr = findHtmlTagRange(inner, search, 'tr');
    if (!tr) break;
    const rowInner = inner.slice(tr.openEnd, tr.closeStart);
    const cells: string[] = [];
    let cellSearch = 0;
    while (cellSearch < rowInner.length) {
      const remaining = rowInner.slice(cellSearch);
      const next = remaining.search(/<t[dh]\b/i);
      if (next < 0) break;
      const abs = cellSearch + next;
      const tag = /^<th\b/i.test(rowInner.slice(abs)) ? 'th' : 'td';
      const cell = findHtmlTagRange(rowInner, abs, tag);
      if (!cell) break;
      cells.push(htmlCellToMarkdown(rowInner.slice(cell.openEnd, cell.closeStart)));
      cellSearch = cell.closeEnd;
    }
    if (cells.length > 0) rows.push(cells);
    search = tr.closeEnd;
  }
  return rows;
}

async function htmlTableToDocx(
  html: string,
  docDir: string,
  allowExternalLocalImages = false,
): Promise<Table | null> {
  const rows = parseHtmlTableRows(html);
  if (rows.length === 0) return null;
  const header = rows[0];
  const body = rows.slice(1);
  const alignments = Array.from({ length: header.length }, () => 'left' as const);
  return createDocxTable(
    header,
    body,
    alignments,
    docDir,
    /<th\b/i.test(html),
    allowExternalLocalImages,
  );
}

type DocxMermaidImage = {
  source?: string;
  pngBase64?: string;
  width?: number;
  height?: number;
};

type DocxMermaidPng = { data: Buffer; width: number; height: number; source?: string };

function normalizeDocxMermaidSource(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

function decodePngBase64(value: string): Buffer | null {
  const comma = value.indexOf(',');
  const b64 = value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
  try {
    const data = Buffer.from(b64, 'base64');
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

function looksLikeDocxMermaid(source: string): boolean {
  const head = source.replace(/\r\n/g, '\n').trim().replace(/^(?:%%[^\n]*\n)+/, '').trim();
  return /^(?:flowchart|graph(?:\s+(?:TD|TB|BT|RL|LR))?|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|C4Context|requirementDiagram)\b/.test(head);
}

function isMermaidFenceInfo(info: string): boolean {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() || '';
  return lang === 'mermaid' || lang === 'mermaidjs';
}

type DocxAsciiImage = {
  source?: string;
  pngBase64?: string;
  width?: number;
  height?: number;
};

type DocxAsciiPng = { data: Buffer; width: number; height: number; source?: string };

const DOCX_ASCII_FENCE_LANGS = new Set(['text', 'txt', 'ascii', 'box', 'art', 'diagram']);
const DOCX_ASCII_BOX_CHARS = /[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝║╬═╠╣╦╩╭╮╯╰+|=-]/;

function normalizeDocxAsciiSource(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

function isAsciiFenceInfo(info: string): boolean {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() || '';
  return DOCX_ASCII_FENCE_LANGS.has(lang);
}

function looksLikeDocxAsciiArt(source: string): boolean {
  const lines = normalizeDocxAsciiSource(source).split('\n');
  if (lines.length < 2) return false;
  let borderRows = 0;
  let frameRows = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^[┌└├╔╚╠][─━═-]/.test(trimmed) ||
      /[─━═-]{4,}/.test(line) ||
      /^[-+]{4,}/.test(trimmed)
    ) {
      borderRows++;
    } else if (DOCX_ASCII_BOX_CHARS.test(line)) {
      frameRows++;
    }
  }
  return borderRows >= 1 && borderRows + frameRows >= 2;
}

function unwrapHeadingEmphasis(text: string): string {
  let value = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const wrap of ['***', '___', '**', '__', '*', '_']) {
      if (value.startsWith(wrap) && value.endsWith(wrap) && value.length > wrap.length * 2) {
        const inner = value.slice(wrap.length, -wrap.length);
        if (!inner.includes(wrap)) {
          value = inner.trim();
          changed = true;
        }
      }
    }
  }
  return value;
}

function createHeadingParagraphStyle(id: string, name: string, outlineLevel: number, size: number) {
  return {
    id,
    name,
    basedOn: 'Normal',
    next: 'Normal',
    quickStyle: true,
    run: {
      size,
      bold: true,
      italics: false,
      color: '000000',
      font: 'Calibri',
    },
    paragraph: {
      spacing: { before: 240, after: 80 },
      outlineLevel,
    },
  };
}

function createDocxHeadingParagraph(level: number, text: string): Paragraph {
  const sizes: Record<number, number> = { 1: 48, 2: 40, 3: 32, 4: 28, 5: 24, 6: 22 };
  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
  };
  const runs = markdownInlineToDocxRuns(unwrapHeadingEmphasis(text), {
    bold: true,
    italics: false,
    color: '000000',
    size: sizes[level] ?? 28,
  });
  if (level >= 4) {
    return new Paragraph({
      style: `EasyViewHeading${level}`,
      outlineLevel: level - 1,
      spacing: { before: 240, after: 80 },
      children: runs,
    });
  }
  return new Paragraph({
    heading: headingMap[level] ?? HeadingLevel.HEADING_3,
    children: runs,
  });
}

export async function markdownToDocx(
  markdown: string,
  title: string,
  docDir: string,
  mermaidImages: DocxMermaidImage[] = [],
  asciiImages: DocxAsciiImage[] = [],
  allowExternalLocalImages = false,
): Promise<DocxDocument> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const documentChildren: (Paragraph | Table)[] = [];
  const mermaidQueue: DocxMermaidPng[] = [];
  for (const image of mermaidImages) {
    if (!image?.pngBase64) continue;
    const data = decodePngBase64(image.pngBase64);
    if (!data) continue;
    mermaidQueue.push({
      data,
      width: Number(image.width) || 520,
      height: Number(image.height) || 300,
      source: normalizeDocxMermaidSource(image.source || ''),
    });
  }
  const takeMermaidImage = (source: string): DocxMermaidPng | undefined => {
    const key = normalizeDocxMermaidSource(source);
    const bySource = mermaidQueue.findIndex((item) => item.source && item.source === key);
    if (bySource >= 0) return mermaidQueue.splice(bySource, 1)[0];
    return mermaidQueue.shift();
  };

  const asciiQueue: DocxAsciiPng[] = [];
  for (const image of asciiImages) {
    if (!image?.pngBase64) continue;
    const data = decodePngBase64(image.pngBase64);
    if (!data) continue;
    asciiQueue.push({
      data,
      width: Number(image.width) || 900,
      height: Number(image.height) || 300,
      source: normalizeDocxAsciiSource(image.source || ''),
    });
  }
  const takeAsciiImage = (source: string): DocxAsciiPng | undefined => {
    const key = normalizeDocxAsciiSource(source);
    const bySource = asciiQueue.findIndex((item) => item.source && item.source === key);
    if (bySource >= 0) return asciiQueue.splice(bySource, 1)[0];
    return asciiQueue.shift();
  };

  // Consecutive Markdown text lines are soft line breaks, not separate Word paragraphs.
  let pendingBodyRuns: TextRun[] = [];
  const flushPendingBody = () => {
    if (pendingBodyRuns.length === 0) return;
    documentChildren.push(new Paragraph({
      children: pendingBodyRuns,
      spacing: { after: 0 },
      alignment: AlignmentType.LEFT,
    }));
    pendingBodyRuns = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].replace(/\t/g, '    ');
    const trimmed = line.trim();

    if (!trimmed) { flushPendingBody(); continue; }

    if (/^<!--/.test(trimmed)) {
      flushPendingBody();
      while (lineIndex < lines.length && !lines[lineIndex].includes('-->')) lineIndex++;
      continue;
    }

    if (trimmed.startsWith('```')) {
      flushPendingBody();
      const fenceInfo = trimmed.slice(3).trim().split(/\s+/)[0]?.toLowerCase() || '';
      const codeLines: string[] = [];
      lineIndex++;
      while (lineIndex < lines.length && !lines[lineIndex].trim().startsWith('```')) {
        codeLines.push(lines[lineIndex]);
        lineIndex++;
      }
      const codeText = codeLines.join('\n');
      if (isMermaidFenceInfo(fenceInfo) || (!fenceInfo && looksLikeDocxMermaid(codeText))) {
        const mermaidPng = takeMermaidImage(codeText);
        if (mermaidPng) {
          const fitted = fitMermaidToDocxPage(mermaidPng.width, mermaidPng.height, mermaidPng.data);
          documentChildren.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 160, after: 160 },
            children: [new ImageRun({ type: 'png', data: mermaidPng.data, transformation: fitted })],
          }));
          continue;
        }
      }
      if (isAsciiFenceInfo(fenceInfo) || looksLikeDocxAsciiArt(codeText)) {
        const asciiPng = takeAsciiImage(codeText);
        if (asciiPng) {
          const fitted = fitMermaidToDocxPage(asciiPng.width, asciiPng.height, asciiPng.data);
          documentChildren.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 160, after: 160 },
            children: [new ImageRun({ type: 'png', data: asciiPng.data, transformation: fitted })],
          }));
          continue;
        }
      }
      const codeRuns: TextRun[] = [];
      codeLines.forEach((codeLine, index) => {
        if (index > 0) codeRuns.push(new TextRun({ text: '', break: 1, font: 'Courier New', size: 18 }));
        codeRuns.push(new TextRun({ text: codeLine || ' ', font: 'Courier New', size: 18 }));
      });
      documentChildren.push(new Paragraph({
        shading: { fill: 'F6F8FA' },
        spacing: { before: 80, after: 80 },
        alignment: AlignmentType.LEFT,
        children: codeRuns.length > 0 ? codeRuns : [new TextRun({ text: ' ', font: 'Courier New', size: 18 })],
      }));
      continue;
    }

    if (/<table[\s>]/i.test(trimmed) || (trimmed === '<table>' || /^<table\b/i.test(trimmed))) {
      const consumed = consumeHtmlTable(lines, lineIndex);
      if (consumed) {
        flushPendingBody();
        const table = await htmlTableToDocx(consumed.html, docDir, allowExternalLocalImages);
        if (table) documentChildren.push(table);
        lineIndex = consumed.endIndex;
        continue;
      }
    }

    if (isMarkdownTableStart(trimmed, lines[lineIndex + 1] ?? '')) {
      flushPendingBody();
      const pipeRows: string[] = [];
      while (lineIndex < lines.length) {
        const row = lines[lineIndex];
        const rowTrimmed = row.trim();
        if (!rowTrimmed) break;
        if (!isMarkdownPipeRow(row) && !isMarkdownTableSeparatorLine(row)) break;
        pipeRows.push(row);
        lineIndex++;
      }
      lineIndex--;
      const parsedRows = pipeRows.map((row) => splitMarkdownTableRow(row));
      const separatorAlignments = parsedRows.length > 1 ? parseMarkdownTableAlignments(parsedRows[1]) : null;
      const header = parsedRows[0];
      const body = separatorAlignments ? parsedRows.slice(2) : parsedRows.slice(1);
      const alignments = separatorAlignments
        ?? Array.from({ length: Math.max(header.length, ...body.map((row) => row.length), 1) }, () => 'left' as const);
      documentChildren.push(await createDocxTable(
        header,
        body,
        alignments,
        docDir,
        Boolean(separatorAlignments),
        allowExternalLocalImages,
      ));
      continue;
    }

    if (isEmptyMarkdownHeadingLine(trimmed)) {
      flushPendingBody();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushPendingBody();
      const headingText = unwrapHeadingEmphasis(headingMatch[2]);
      if (!headingText) continue;
      documentChildren.push(createDocxHeadingParagraph(headingMatch[1].length, headingMatch[2]));
      continue;
    }

    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
      flushPendingBody();
      const level = Math.max(0, Math.min(8, Math.floor((bulletMatch[1]?.length ?? 0) / 2)));
      documentChildren.push(new Paragraph({
        indent: { left: 420 + level * 360, hanging: 280 },
        alignment: AlignmentType.LEFT,
        spacing: { after: 60 },
        children: [
          new TextRun({ text: '• ', color: '000000', size: 22 }),
          ...markdownInlineToDocxRuns(bulletMatch[3]),
        ],
      }));
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      flushPendingBody();
      const level = Math.max(0, Math.min(8, Math.floor((orderedMatch[1]?.length ?? 0) / 2)));
      const num = Number.parseInt(orderedMatch[2], 10);
      documentChildren.push(new Paragraph({
        indent: { left: 420 + level * 360, hanging: 360 },
        alignment: AlignmentType.LEFT,
        spacing: { after: 60 },
        children: [
          new TextRun({ text: `${Number.isFinite(num) ? num : 1}. `, color: '000000' }),
          ...markdownInlineToDocxRuns(orderedMatch[3]),
        ],
      }));
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushPendingBody();
      const quoteLines: string[] = [];
      while (lineIndex < lines.length) {
        const candidate = lines[lineIndex].replace(/\t/g, '    ').match(/^>\s?(.*)$/);
        if (!candidate) break;
        quoteLines.push(candidate[1]);
        lineIndex++;
      }
      lineIndex--;
      const noticeMatch = quoteLines[0]?.trim().match(/^\[!(note|tip|important|caution|warning)\]\s*$/i);
      const noticeStyle = noticeMatch ? DOCX_NOTICE_STYLES[noticeMatch[1].toLowerCase()] : undefined;
      const contentLines = noticeStyle ? quoteLines.slice(1) : quoteLines;
      const rendered = contentLines.length > 0 ? contentLines : [noticeStyle?.title ?? ''];
      rendered.forEach((quoteLine, index) => documentChildren.push(
        createDocxBlockquoteParagraph(quoteLine, index === 0, index === rendered.length - 1, noticeStyle)
      ));
      continue;
    }

    if (/^---+$/.test(trimmed) || /^___+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushPendingBody();
      documentChildren.push(new Paragraph({ thematicBreak: true }));
      continue;
    }

    const imageMatches = [...line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)(?:\s*\{[^}]+\})?/g)];
    if (imageMatches.length > 0) {
      flushPendingBody();
      const children: (TextRun | ImageRun)[] = [];
      let cursor = 0;
      for (const match of imageMatches) {
        const matchText = match[0];
        const altText = (match[1] ?? '').trim();
        const imageSrc = parseMarkdownImageTarget(match[2] ?? '');
        const start = match.index ?? 0;
        const end = start + matchText.length;
        const before = line.slice(cursor, start);
        if (before.trim()) children.push(...markdownInlineToDocxRuns(before));
        try {
          const imageResolved = await resolveDocxImageData(imageSrc, docDir, allowExternalLocalImages);
          if (imageResolved) {
            const dimensions = getImageDimensions(imageResolved.type, imageResolved.data);
            const fitted = fitImageIntoBounds(dimensions?.width ?? 520, dimensions?.height ?? 300);
            children.push(new ImageRun({ type: imageResolved.type, data: imageResolved.data, transformation: fitted }));
          } else children.push(new TextRun(`[Image: ${altText || imageSrc}]`));
        } catch { children.push(new TextRun(`[Image: ${altText || imageSrc}]`)); }
        cursor = end;
      }
      const after = line.slice(cursor);
      if (after.trim()) children.push(...markdownInlineToDocxRuns(after));
      documentChildren.push(new Paragraph({
        alignment: AlignmentType.LEFT,
        children: children.length > 0 ? children : markdownInlineToDocxRuns(trimmed),
      }));
      continue;
    }

    const bodyRuns = markdownInlineToDocxRuns(trimmed);
    pendingBodyRuns.push(...(pendingBodyRuns.length > 0
      ? [new TextRun({ text: '', break: 1 }), ...bodyRuns]
      : bodyRuns));
  }

  flushPendingBody();
  if (documentChildren.length === 0) {
    documentChildren.push(new Paragraph({ children: [] }));
  }
  return new DocxDocument({
    title: title || undefined,
    styles: {
      default: {
        document: {
          paragraph: { alignment: AlignmentType.LEFT },
          run: { color: '000000' },
        },
      },
      paragraphStyles: [
        createHeadingParagraphStyle('EasyViewHeading4', 'Heading 4', 3, 28),
        createHeadingParagraphStyle('EasyViewHeading5', 'Heading 5', 4, 24),
        createHeadingParagraphStyle('EasyViewHeading6', 'Heading 6', 5, 22),
        createHeadingParagraphStyle('Heading4', 'Heading 4', 3, 28),
        createHeadingParagraphStyle('Heading5', 'Heading 5', 4, 24),
        createHeadingParagraphStyle('Heading6', 'Heading 6', 5, 22),
      ],
    },
    sections: createDocxSections(documentChildren),
  });
}

export async function markdownToDocxBuffer(
  markdown: string,
  title: string,
  docDir: string,
  mermaidImages: Array<{ source: string; pngBase64: string; width: number; height: number }> = [],
  asciiImages: Array<{ source: string; pngBase64: string; width: number; height: number }> = [],
  allowExternalLocalImages = false,
): Promise<Buffer> {
  const document = await markdownToDocx(
    markdown,
    title,
    docDir,
    mermaidImages,
    asciiImages,
    allowExternalLocalImages,
  );
  return Buffer.from(await Packer.toBuffer(document));
}


export interface DocxExportWriteRequest {
  targetPath: string;
  markdown: string;
  title: string;
  docDir: string;
  mermaidImages?: Array<{ source: string; pngBase64: string; width: number; height: number }>;
  asciiImages?: Array<{ source: string; pngBase64: string; width: number; height: number }>;
  allowExternalLocalImages?: boolean;
}

export interface DocxExportWriteResult {
  filePath: string;
  byteLength: number;
}

export async function writeDocxExport(request: DocxExportWriteRequest): Promise<DocxExportWriteResult> {
  if (!request.targetPath) throw new TypeError('targetPath must be a non-empty path');
  const buffer = await markdownToDocxBuffer(
    request.markdown,
    request.title,
    request.docDir,
    request.mermaidImages ?? [],
    request.asciiImages ?? [],
    request.allowExternalLocalImages ?? false,
  );
  await mkdir(path.dirname(request.targetPath), { recursive: true });
  await writeFileAtomically(request.targetPath, buffer);
  return { filePath: request.targetPath, byteLength: buffer.length };
}
