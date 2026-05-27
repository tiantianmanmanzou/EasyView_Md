/**
 * InLineMd Markdown Parser
 *
 * Converts Markdown text -> ProseMirror document using markdown-it + prosemirror-markdown.
 * Inspired by Outline's parser architecture with custom markdown-it plugins.
 */

import markdownit from 'markdown-it';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItDeflist from 'markdown-it-deflist';
import { MarkdownParser } from 'prosemirror-markdown';
import { DOMParser as PmDOMParser, type Node as ProsemirrorNode, Fragment } from 'prosemirror-model';
import { schema } from '../EditorSchema';
import { parseMarkdownWithFrontmatter } from './Frontmatter';
import { applyCustomRules } from './MarkdownItRules';
import { applyTableRules } from './MarkdownTableRules';
import { tokenMapping } from './MarkdownTokenMapping';

// ─── markdown-it instance ───────────────────────────────────────────────────

function createMarkdownIt(options?: { linkify?: boolean }) {
  const md = markdownit('default', {
    breaks: false,
    html: true,
    linkify: options?.linkify ?? false,
  });

  // Enable strikethrough
  md.enable('strikethrough');

  // Description lists plugin: Term\n: Definition
  md.use(markdownItDeflist);

  // Footnotes plugin: [^label] references and [^label]: definitions
  md.use(markdownItFootnote);

  // Apply all custom markdown-it rules
  applyCustomRules(md);

  // Apply table-related rules
  applyTableRules(md);

  return md;
}

// ─── Create parsers ─────────────────────────────────────────────────────────

export function createParser() {
  const md = createMarkdownIt({ linkify: false });
  return new MarkdownParser(schema, md, tokenMapping);
}

export function createPasteParser() {
  const md = createMarkdownIt({ linkify: true });
  return new MarkdownParser(schema, md, tokenMapping);
}

/**
 * Parse markdown with frontmatter support
 *
 * Extracts YAML frontmatter and creates a ProseMirror document
 * with frontmatter as the first node if present.
 */
/**
 * Post-process table cells: restore complex content from <!--html--> markers.
 * Walks the doc, finds table_cell/table_header nodes whose paragraph text
 * starts with <!--html-->, parses the HTML with ProseMirror DOMParser,
 * and replaces the cell content.
 */
function restoreHtmlCells(doc: ProsemirrorNode): ProsemirrorNode {
  const pmParser = PmDOMParser.fromSchema(schema);
  let changed = false;

  function processNode(node: ProsemirrorNode): ProsemirrorNode {
    if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
      // Check if cell has a single paragraph starting with <!--htmlcell--> (internal marker from fix_tables)
      if (node.childCount === 1 && node.firstChild?.type.name === 'paragraph') {
        const text = node.firstChild.textContent;
        if (text.startsWith('<!--htmlcell-->')) {
          const html = text.slice('<!--htmlcell-->'.length).replace(/&#124;/g, '|');
          // Parse HTML into ProseMirror nodes
          const wrapper = document.createElement('td');
          wrapper.innerHTML = html;
          // Strip notice markers: <blockquote> first child <p>[!type]</p> → consumed by parseDOM getAttrs
          wrapper.querySelectorAll('blockquote > p:first-child').forEach(p => {
            if (/^\[!\w+\]$/.test(p.textContent || '')) p.remove();
          });
          // Strip checkbox inputs (consumed by parseDOM getAttrs, not content)
          wrapper.querySelectorAll('li > input[type="checkbox"]').forEach(inp => inp.remove());
          try {
            const parsed = pmParser.parse(wrapper);
            // parsed is a doc node; extract its content (the block nodes)
            if (parsed.content.childCount > 0) {
              changed = true;
              return node.type.create(node.attrs, parsed.content);
            }
          } catch {
            // Fallback: keep original content
          }
        }
      }
      return node;
    }

    // Recurse into children
    let newChildren: ProsemirrorNode[] | null = null;
    node.forEach((child, _offset, index) => {
      const newChild = processNode(child);
      if (newChild !== child) {
        if (!newChildren) {
          // Collect all children up to this point
          newChildren = [];
          for (let j = 0; j < index; j++) {
            newChildren.push(node.child(j));
          }
        }
        newChildren.push(newChild);
      } else if (newChildren) {
        newChildren.push(child);
      }
    });

    if (newChildren) {
      changed = true;
      return node.copy(Fragment.from(newChildren));
    }
    return node;
  }

  const result = processNode(doc);
  return changed ? result : doc;
}

export function parseMarkdown(markdown: string, parser: MarkdownParser): ProsemirrorNode | null {
  const t0 = performance.now();
  const { rawYaml, content, hasFrontmatter } = parseMarkdownWithFrontmatter(markdown);
  const t1 = performance.now();

  // Normalize table column counts before parsing (markdown-it requires
  // header and separator to have the same number of columns)
  const normalizedContent = normalizeTableColumns(content);

  // Parse main content
  let contentDoc = parser.parse(normalizedContent);
  const t2 = performance.now();

  if (!contentDoc) {
    return null;
  }

  if (contentDoc.childCount === 0) {
    contentDoc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]);
  }

  // Restore complex HTML content in table cells
  contentDoc = restoreHtmlCells(contentDoc);
  const t3 = performance.now();

  if (t2 - t0 > 5) {
    console.log(`[InLineMd perf]     parseMarkdown breakdown: frontmatter=${(t1 - t0).toFixed(1)}ms, parser.parse=${(t2 - t1).toFixed(1)}ms, restoreHtmlCells=${(t3 - t2).toFixed(1)}ms`);
  }

  // If no frontmatter, return as-is
  if (!hasFrontmatter || !rawYaml) {
    return contentDoc;
  }

  // Create frontmatter node preserving original YAML text
  const yamlText = rawYaml.trim();
  const frontmatterNode = schema.nodes.frontmatter.create(
    null,
    yamlText ? schema.text(yamlText) : undefined
  );

  // Combine frontmatter + content
  const bodyNodes = contentDoc.childCount > 0
    ? contentDoc.content.content
    : [schema.nodes.paragraph.create()];
  const nodes = [frontmatterNode, ...bodyNodes];
  return schema.nodes.doc.create(null, nodes);
}

// ─── Table column normalization ─────────────────────────────────────────────

/** Count columns in a pipe-delimited table row */
function countTableColumns(line: string): number {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split('|').length;
}

/** Pad a data row with empty cells */
function padTableRow(line: string, currentCols: number, targetCols: number): string {
  if (currentCols >= targetCols) return line;
  const base = line.trimEnd().endsWith('|') ? line.trimEnd() : line.trimEnd() + ' |';
  return base + '  |'.repeat(targetCols - currentCols);
}

/** Pad a separator row with --- cells */
function padSeparatorRow(line: string, currentCols: number, targetCols: number): string {
  if (currentCols >= targetCols) return line;
  const base = line.trimEnd().endsWith('|') ? line.trimEnd() : line.trimEnd() + ' |';
  return base + ' --- |'.repeat(targetCols - currentCols);
}

/**
 * Normalize table column counts so markdown-it can parse them.
 * markdown-it requires the separator row and header row to have
 * the same number of columns; mismatched tables are rejected.
 */
function normalizeTableColumns(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip fenced code blocks
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      result.push(lines[i]);
      continue;
    }
    if (inCodeBlock) {
      result.push(lines[i]);
      continue;
    }

    // Detect separator line: | --- | --- | or | :---: | ---: | etc.
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(trimmed) && result.length > 0) {
      const headerLine = result[result.length - 1].trim();

      if (headerLine.startsWith('|')) {
        const sepCols = countTableColumns(trimmed);
        const headerCols = countTableColumns(headerLine);

        if (sepCols !== headerCols && sepCols > 0 && headerCols > 0) {
          const targetCols = Math.max(sepCols, headerCols);

          // Pad header
          result[result.length - 1] = padTableRow(result[result.length - 1], headerCols, targetCols);
          // Pad separator
          result.push(padSeparatorRow(lines[i], sepCols, targetCols));

          // Pad subsequent data rows
          i++;
          while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().length > 1) {
            const rowCols = countTableColumns(lines[i].trim());
            result.push(padTableRow(lines[i], rowCols, targetCols));
            i++;
          }
          i--;
          continue;
        }
      }
    }

    result.push(lines[i]);
  }

  return result.join('\n');
}
