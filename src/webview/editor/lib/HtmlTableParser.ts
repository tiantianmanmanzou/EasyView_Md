/**
 * DOM-first HTML table parser for EasyView Markdown.
 *
 * Top-level `<table>...</table>` blocks are extracted from the markdown source,
 * parsed with the browser DOM, and converted to ProseMirror table nodes.
 * Cell text/markdown (including embedded GFM pipe tables) is handled by a
 * markdown sub-parser; nested HTML `<table>` elements are parsed recursively.
 */

import type { MarkdownParser } from 'prosemirror-markdown';
import {
  DOMParser as PmDOMParser,
  Fragment,
  type Node as ProsemirrorNode,
} from 'prosemirror-model';
import { schema } from '../EditorSchema';

export type MarkdownSegment =
  | { type: 'markdown'; content: string }
  | { type: 'html-table'; content: string };

const HTML_TABLE_TAG = /<\/?table(?:\s[^>]*)?>/gi;

// ─── Source splitting ────────────────────────────────────────────────────────

/** Build [start, end) ranges of fenced code blocks so we skip them when scanning. */
function buildFencedCodeRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = markdown.split('\n');
  let offset = 0;
  let openFence: { marker: string; start: number } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!openFence) {
        openFence = { marker, start: offset };
      } else if (marker[0] === openFence.marker[0] && marker.length >= openFence.marker.length) {
        ranges.push([openFence.start, offset + line.length]);
        openFence = null;
      }
    }
    offset += line.length + 1;
  }

  if (openFence) {
    ranges.push([openFence.start, markdown.length]);
  }
  return ranges;
}

function isInsideRange(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

function findNextTableOpen(markdown: string, from: number, codeRanges: Array<[number, number]>): number {
  const re = /<table(?:\s[^>]*)?>/gi;
  re.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    if (!isInsideRange(match.index, codeRanges)) {
      return match.index;
    }
  }
  return -1;
}

function extractHtmlTableAt(source: string, start: number): { html: string; end: number } | null {
  if (!/^<table(?:\s[^>]*)?>/i.test(source.slice(start))) return null;

  HTML_TABLE_TAG.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_TABLE_TAG.exec(source)) !== null) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return { html: source.slice(start, HTML_TABLE_TAG.lastIndex), end: HTML_TABLE_TAG.lastIndex };
    }
  }
  return null;
}

/** Split markdown into plain markdown segments and top-level HTML table blocks. */
export function splitMarkdownByHtmlTables(markdown: string): MarkdownSegment[] {
  const codeRanges = buildFencedCodeRanges(markdown);
  const segments: MarkdownSegment[] = [];
  let mdBuffer = '';
  let cursor = 0;

  const flushMarkdown = () => {
    if (mdBuffer.length > 0) {
      segments.push({ type: 'markdown', content: mdBuffer });
      mdBuffer = '';
    }
  };

  while (cursor < markdown.length) {
    const tableStart = findNextTableOpen(markdown, cursor, codeRanges);
    if (tableStart === -1) {
      mdBuffer += markdown.slice(cursor);
      break;
    }

    mdBuffer += markdown.slice(cursor, tableStart);
    const extracted = extractHtmlTableAt(markdown, tableStart);
    if (!extracted) {
      mdBuffer += markdown[tableStart];
      cursor = tableStart + 1;
      continue;
    }

    flushMarkdown();
    segments.push({ type: 'html-table', content: extracted.html });
    cursor = extracted.end;
  }

  flushMarkdown();
  return segments;
}

// ─── DOM → ProseMirror ───────────────────────────────────────────────────────

function readCellAttrs(cell: HTMLTableCellElement): Record<string, unknown> {
  const widthAttr = cell.getAttribute('data-colwidth');
  const widths =
    widthAttr && /^\d+(,\d+)*$/.test(widthAttr)
      ? widthAttr.split(',').map((value) => Number(value))
      : null;
  const alignAttr = cell.getAttribute('align');
  const valignAttr = cell.getAttribute('valign');
  const style = cell.getAttribute('style') || '';
  const textAlign = cell.style.textAlign || style.match(/text-align\s*:\s*([\w-]+)/i)?.[1] || alignAttr;
  const verticalAlign =
    cell.style.verticalAlign || style.match(/vertical-align\s*:\s*([\w-]+)/i)?.[1] || valignAttr;

  return {
    colspan: cell.colSpan || 1,
    rowspan: cell.rowSpan || 1,
    colwidth: widths && widths.length === cell.colSpan ? widths : null,
    alignment: textAlign || null,
    verticalAlignment: verticalAlign || null,
    duplicateMerged: cell.getAttribute('data-easyview-duplicate-merged') === 'true',
    autoMerged: cell.getAttribute('data-easyview-auto-merged') === 'true',
    mergeGroup: cell.getAttribute('data-easyview-merge-group') || null,
  };
}

function readRowAttrs(row: HTMLTableRowElement): Record<string, unknown> {
  const height = Number(row.getAttribute('data-easyview-row-height'));
  return {
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    sticky: row.getAttribute('data-easyview-sticky') === 'true',
  };
}

function sanitizeCellHtml(root: HTMLElement): void {
  root.querySelectorAll('blockquote > p:first-child').forEach((paragraph) => {
    if (/^\[!\w+\]$/.test(paragraph.textContent || '')) {
      paragraph.remove();
    }
  });
  root.querySelectorAll('li > input[type="checkbox"]').forEach((input) => input.remove());
}

const BLOCK_CELL_TAGS = new Set([
  'P',
  'DIV',
  'TABLE',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'DL',
  'DETAILS',
  'FIGURE',
  'SECTION',
  'ARTICLE',
]);

/** Serialize text/comments/br-only cell contents back to a markdown source string. */
function serializeInlineCellMarkdown(root: HTMLElement): string {
  let out = '';
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent || '';
      continue;
    }
    if (child.nodeType === Node.COMMENT_NODE) {
      out += `<!--${child.textContent}-->`;
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as HTMLElement;
      if (element.tagName === 'BR') {
        out += '\n';
        continue;
      }
      return root.innerHTML;
    }
  }
  return out;
}

function cellHasBlockElements(root: HTMLElement): boolean {
  return Array.from(root.children).some((child) => BLOCK_CELL_TAGS.has(child.tagName));
}

function parseMarkdownBlocks(text: string, parser: MarkdownParser): ProsemirrorNode[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const blocks: ProsemirrorNode[] = [];
  for (const segment of splitMarkdownByHtmlTables(trimmed)) {
    if (segment.type === 'html-table') {
      const table = parseHtmlTableBlock(segment.content, parser);
      if (table) blocks.push(table);
      continue;
    }
    if (!segment.content.trim()) continue;
    const doc = parser.parse(segment.content);
    if (doc && doc.childCount > 0) {
      blocks.push(...(doc.content.content as ProsemirrorNode[]));
    }
  }
  return blocks;
}

function parseHtmlElementBlock(element: HTMLElement, pmDomParser: PmDOMParser): ProsemirrorNode[] {
  const wrapper = document.createElement('div');
  wrapper.appendChild(element.cloneNode(true));
  sanitizeCellHtml(wrapper);
  try {
    const parsed = pmDomParser.parse(wrapper);
    return parsed.content.content as ProsemirrorNode[];
  } catch {
    const text = element.textContent?.trim();
    return text ? [schema.nodes.paragraph.create(null, schema.text(text))] : [];
  }
}

function parseCellContent(
  cell: HTMLTableCellElement,
  parser: MarkdownParser,
  pmDomParser: PmDOMParser,
): Fragment {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cell.innerHTML;
  sanitizeCellHtml(wrapper);

  if (wrapper.childNodes.length === 0) {
    return Fragment.from([schema.nodes.paragraph.create()]);
  }

  if (!cellHasBlockElements(wrapper)) {
    const blocks = parseMarkdownBlocks(serializeInlineCellMarkdown(wrapper), parser);
    return Fragment.from(blocks.length > 0 ? blocks : [schema.nodes.paragraph.create()]);
  }

  const blocks: ProsemirrorNode[] = [];
  for (const child of Array.from(wrapper.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      blocks.push(...parseMarkdownBlocks(child.textContent || '', parser));
      continue;
    }
    if (child.nodeType === Node.COMMENT_NODE) {
      blocks.push(...parseMarkdownBlocks(`<!--${child.textContent}-->`, parser));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as HTMLElement;
    if (element.tagName === 'TABLE') {
      const nested = parseHtmlTableElement(element as HTMLTableElement, parser, pmDomParser);
      if (nested) blocks.push(nested);
      continue;
    }
    blocks.push(...parseHtmlElementBlock(element, pmDomParser));
  }

  return Fragment.from(blocks.length > 0 ? blocks : [schema.nodes.paragraph.create()]);
}

function getDirectRows(table: HTMLTableElement): HTMLTableRowElement[] {
  const rows: HTMLTableRowElement[] = [];
  for (const section of Array.from(table.children)) {
    const tag = section.tagName;
    if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      rows.push(...Array.from(section.querySelectorAll(':scope > tr')) as HTMLTableRowElement[]);
    } else if (tag === 'TR') {
      rows.push(section as HTMLTableRowElement);
    }
  }
  return rows;
}

function parseHtmlTableElement(
  table: HTMLTableElement,
  parser: MarkdownParser,
  pmDomParser: PmDOMParser,
): ProsemirrorNode | null {
  const rows = getDirectRows(table);
  if (rows.length === 0) return null;

  const pmRows: ProsemirrorNode[] = [];
  for (const row of rows) {
    const cells: ProsemirrorNode[] = [];
    for (const cell of Array.from(row.cells)) {
      const isHeader = cell.tagName === 'TH';
      const nodeType = isHeader ? schema.nodes.table_header : schema.nodes.table_cell;
      const content = parseCellContent(cell, parser, pmDomParser);
      cells.push(nodeType.create(readCellAttrs(cell), content));
    }
    pmRows.push(schema.nodes.table_row.create(readRowAttrs(row), cells));
  }

  return schema.nodes.table.create(null, pmRows);
}

/** Parse a top-level HTML table block into a ProseMirror table node. */
export function parseHtmlTableBlock(html: string, parser: MarkdownParser): ProsemirrorNode | null {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  const table = wrapper.querySelector('table');
  if (!table) return null;
  const pmDomParser = PmDOMParser.fromSchema(schema);
  return parseHtmlTableElement(table, parser, pmDomParser);
}

/** Parse mixed markdown + HTML table source into a ProseMirror document body. */
export function parseMarkdownWithHtmlTables(
  markdown: string,
  parser: MarkdownParser,
): ProsemirrorNode {
  const segments = splitMarkdownByHtmlTables(markdown);
  const blocks: ProsemirrorNode[] = [];

  for (const segment of segments) {
    if (segment.type === 'html-table') {
      const table = parseHtmlTableBlock(segment.content, parser);
      if (table) blocks.push(table);
      continue;
    }
    if (!segment.content.trim()) continue;
    const doc = parser.parse(segment.content);
    if (doc && doc.childCount > 0) {
      blocks.push(...(doc.content.content as ProsemirrorNode[]));
    }
  }

  if (blocks.length === 0) {
    return schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]);
  }
  return schema.nodes.doc.create(null, blocks);
}
