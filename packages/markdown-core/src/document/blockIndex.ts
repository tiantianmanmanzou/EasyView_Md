import { buildLineStartIndex, type LineStartIndex } from './lineIndex';

export type MarkdownBlockType =
  | 'paragraph'
  | 'heading'
  | 'fencedCode'
  | 'chartFence'
  | 'blockquote'
  | 'list'
  | 'table'
  | 'htmlTable'
  | 'frontmatter'
  | 'referenceDefinition'
  | 'footnote'
  | 'tableMetadata';

export interface SourceRange {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

export interface MarkdownBlockRange extends SourceRange {
  id: number;
  type: MarkdownBlockType;
  text: string;
  /** A stable-enough PoC key for comparing a block before and after a patch. */
  key: string;
  invalidationScope: 'block' | 'document';
}

export interface MarkdownDocumentIndex {
  content: string;
  lines: LineStartIndex;
  blocks: readonly MarkdownBlockRange[];
}

const HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;
const LIST_RE = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const TABLE_SEPARATOR_RE = /^ {0,3}\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?$/;
const REFERENCE_RE = /^ {0,3}\[[^\]^\n]+\]:\s*\S+/;
const FOOTNOTE_RE = /^ {0,3}\[\^[^\]]+\]:/;
const TABLE_METADATA_RE = /<!--\s*(?:easyview[-_ ]*)?(?:table|table-style|table_style|table-metadata)[\s\S]*?-->/i;
const HTML_TABLE_OPEN_RE = /^\s*<table(?:\s|>)/i;
const HTML_TABLE_CLOSE_RE = /<\/table>\s*$/i;

function trimLine(content: string, lineStart: number, lineEnd: number): string {
  return content.slice(lineStart, lineEnd);
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line);
}

function fenceInfo(line: string): { marker: string; info: string } | undefined {
  const match = line.match(FENCE_RE);
  return match ? { marker: match[1], info: match[2].trim().toLowerCase() } : undefined;
}

function isChartInfo(info: string): boolean {
  return /^(mermaid|plantuml|puml|drawio|graphviz|dot|vega|vega-lite|echarts)\b/.test(info);
}

function isTableStart(lines: string[], index: number): boolean {
  return index + 1 < lines.length && lines[index].includes('|') && TABLE_SEPARATOR_RE.test(lines[index + 1]);
}

function blockTypeForSpecialLine(line: string): MarkdownBlockType | undefined {
  if (FOOTNOTE_RE.test(line)) return 'footnote';
  if (REFERENCE_RE.test(line)) return 'referenceDefinition';
  if (TABLE_METADATA_RE.test(line)) return 'tableMetadata';
  return undefined;
}

function makeBlock(
  content: string,
  lineIndex: LineStartIndex,
  id: number,
  type: MarkdownBlockType,
  startLine: number,
  endLine: number,
  invalidationScope: 'block' | 'document' = 'block',
): MarkdownBlockRange {
  const start = lineIndex.lineStart(startLine);
  const end = lineIndex.lineEnd(endLine);
  const text = content.slice(start, end);
  return {
    id,
    type,
    text,
    start,
    end,
    startLine,
    endLine,
    key: `${type}:${text}`,
    invalidationScope,
  };
}

/**
 * Builds a top-level, line-oriented Markdown source index. This is intentionally
 * conservative: structural constructs with document-wide dependencies are marked
 * as document-scope instead of attempting unsafe local parsing.
 */
export function buildMarkdownDocumentIndex(content: string): MarkdownDocumentIndex {
  const lines = buildLineStartIndex(content);
  const lineTexts = Array.from({ length: lines.starts.length }, (_, line) => content.slice(lines.lineStart(line), lines.lineEnd(line)));
  const blocks: MarkdownBlockRange[] = [];
  let line = 0;
  let id = 0;

  const push = (type: MarkdownBlockType, start: number, end: number, scope: 'block' | 'document' = 'block') => {
    blocks.push(makeBlock(content, lines, id++, type, start, end, scope));
  };

  while (line < lineTexts.length) {
    const current = lineTexts[line];
    if (isBlank(current)) {
      line += 1;
      continue;
    }

    if (line === 0 && /^\uFEFF?---\s*$/.test(current)) {
      let end = line + 1;
      while (end < lineTexts.length && !/^\s*(?:---|\.\.\.)\s*$/.test(lineTexts[end])) end += 1;
      if (end < lineTexts.length) end += 1;
      push('frontmatter', line, Math.min(end, lineTexts.length - 1), 'document');
      line = Math.min(end, lineTexts.length);
      continue;
    }

    const special = blockTypeForSpecialLine(current);
    if (special) {
      push(special, line, line, 'document');
      line += 1;
      continue;
    }

    const fence = fenceInfo(current);
    if (fence) {
      let end = line + 1;
      const closeRe = new RegExp(`^ {0,3}${fence.marker[0]}{${fence.marker.length},}\\s*$`);
      while (end < lineTexts.length && !closeRe.test(lineTexts[end])) end += 1;
      if (end < lineTexts.length) end += 1;
      push(isChartInfo(fence.info) ? 'chartFence' : 'fencedCode', line, Math.min(end, lineTexts.length) - 1);
      line = Math.min(end, lineTexts.length);
      continue;
    }

    if (HTML_TABLE_OPEN_RE.test(current)) {
      let end = line;
      while (end + 1 < lineTexts.length && !HTML_TABLE_CLOSE_RE.test(lineTexts[end])) end += 1;
      push('htmlTable', line, end);
      line = end + 1;
      continue;
    }

    if (HEADING_RE.test(current)) {
      push('heading', line, line);
      line += 1;
      continue;
    }

    if (isTableStart(lineTexts, line)) {
      let end = line + 1;
      while (end + 1 < lineTexts.length && !isBlank(lineTexts[end + 1]) && lineTexts[end + 1].includes('|')) end += 1;
      push('table', line, end);
      line = end + 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(current)) {
      let end = line;
      while (end + 1 < lineTexts.length && (BLOCKQUOTE_RE.test(lineTexts[end + 1]) || isBlank(lineTexts[end + 1]))) end += 1;
      while (end > line && isBlank(lineTexts[end])) end -= 1;
      push('blockquote', line, end);
      line = end + 1;
      continue;
    }

    if (LIST_RE.test(current)) {
      let end = line;
      while (end + 1 < lineTexts.length && (LIST_RE.test(lineTexts[end + 1]) || /^ {2,}\S/.test(lineTexts[end + 1]) || isBlank(lineTexts[end + 1]))) end += 1;
      while (end > line && isBlank(lineTexts[end])) end -= 1;
      push('list', line, end);
      line = end + 1;
      continue;
    }

    let end = line;
    while (end + 1 < lineTexts.length && !isBlank(lineTexts[end + 1])) {
      const next = lineTexts[end + 1];
      if (HEADING_RE.test(next) || fenceInfo(next) || BLOCKQUOTE_RE.test(next) || LIST_RE.test(next) || blockTypeForSpecialLine(next) || isTableStart(lineTexts, end + 1) || HTML_TABLE_OPEN_RE.test(next)) break;
      end += 1;
    }
    push('paragraph', line, end);
    line = end + 1;
  }

  return { content, lines, blocks };
}
