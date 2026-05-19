/**
 * InLineMd Markdown Serializer
 *
 * Converts ProseMirror document back to Markdown string.
 * Based on prosemirror-markdown's MarkdownSerializer with extensions
 * for tables, notices, checkboxes, highlight, underline.
 */

import {
  MarkdownSerializer,
  MarkdownSerializerState,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import type { Node as ProsemirrorNode, Mark } from 'prosemirror-model';

// ─── Node Serializers ──────────────────────────────────────────────────────

function serializeHeading(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.write('#'.repeat(node.attrs.level) + ' ');
  state.renderInline(node);
  state.closeBlock(node);
}

function serializeParagraph(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.renderInline(node);
  state.closeBlock(node);
}

function serializeBlockquote(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.wrapBlock('> ', null, node, () => state.renderContent(node));
}

function serializeCodeBlock(state: MarkdownSerializerState, node: ProsemirrorNode) {
  const lang = node.attrs.language || '';
  state.write(`\`\`\`${lang}\n`);
  state.text(node.textContent, false);
  state.write('\n```');
  state.closeBlock(node);
}

function serializeHorizontalRule(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.write('---');
  state.closeBlock(node);
}

function serializeBulletList(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.renderList(node, '  ', () => '- ');
}

function serializeOrderedList(state: MarkdownSerializerState, node: ProsemirrorNode) {
  const start = node.attrs.order || 1;
  state.renderList(node, '   ', (i: number) => `${start + i}. `);
}

function serializeListItem(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.renderContent(node);
}

function serializeCheckboxList(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.renderList(node, '  ', () => '- ');
}

function serializeCheckboxItem(state: MarkdownSerializerState, node: ProsemirrorNode) {
  const checked = node.attrs.checked;
  const prefix = checked === 'inapplicable' ? '[~] ' : checked ? '[x] ' : '[ ] ';
  state.write(prefix);
  state.renderContent(node);
}

function serializeNotice(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.write(`> [!${node.attrs.style || 'note'}]\n`);
  state.wrapBlock('> ', null, node, () => state.renderContent(node));
}

/**
 * Format a URL for markdown link/image syntax.
 * If the URL contains spaces or parentheses, wrap in angle brackets (CommonMark standard).
 * Also escape parentheses in non-angle-bracket URLs.
 */
function formatUrl(url: string): string {
  if (!url) return '';
  if (/[\s()]/.test(url)) return `<${url}>`;
  return url;
}

function serializeDetails(state: MarkdownSerializerState, node: ProsemirrorNode) {
  const summary = (node.attrs.summary || 'Details')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  state.write(`<details>\n<summary>${summary}</summary>\n\n`);
  state.renderContent(node);
  state.write('</details>');
  state.closeBlock(node);
}

function serializeImage(state: MarkdownSerializerState, node: ProsemirrorNode) {
  const alt = state.esc(node.attrs.alt || '');
  // Use originalSrc if available (for local images), otherwise use src (for http/https)
  const src = node.attrs.originalSrc || node.attrs.src || '';
  const title = node.attrs.title ? ` "${state.esc(node.attrs.title)}"` : '';
  state.write(`![${alt}](${formatUrl(src)}${title})`);
  // Append GitLab-style dimensions {width=X height=Y} if set
  const dims: string[] = [];
  if (node.attrs.width) dims.push(`width=${node.attrs.width}`);
  if (node.attrs.height) dims.push(`height=${node.attrs.height}`);
  if (dims.length) state.write(`{${dims.join(' ')}}`);
}

/**
 * Serialize a table as an HTML <table> with markdown inside cells.
 * GitLab processes markdown inside HTML table cells (with blank lines around content).
 * This preserves notices, lists, blockquotes, etc. with full fidelity.
 */
function serializeTableAsHtml(state: MarkdownSerializerState, node: ProsemirrorNode, rows: ProsemirrorNode[]) {
  const isHeader = rows[0].firstChild?.type.name === 'table_header';

  state.write('<table>\n');

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    state.write('<tr>\n');

    for (let c = 0; c < row.childCount; c++) {
      const cell = row.child(c);
      const tag = (r === 0 && isHeader) ? 'th' : 'td';
      const align = cell.attrs.alignment;
      const alignAttr = align ? ` align="${align}"` : '';

      // Serialize cell content as markdown using the main serializer
      const cellDoc = cell.type.schema.node('doc', null, cell.content.content);
      const cellMd = serializer.serialize(cellDoc).trim();

      // Always use blank-line format so markdown-it processes content as markdown
      state.write(`<${tag}${alignAttr}>\n\n${cellMd}\n\n</${tag}>\n`);
    }

    state.write('</tr>\n');
  }

  state.write('</table>');
  state.closeBlock(node);
}

function serializeTable(state: MarkdownSerializerState, node: ProsemirrorNode) {
  // Collect rows
  const rows: ProsemirrorNode[] = [];
  node.forEach((row) => rows.push(row));

  if (rows.length === 0) return;

  // Determine column count from first row
  const colCount = rows[0].childCount;

  // Check if any cell has complex content → use HTML table format
  let hasComplex = false;
  for (const row of rows) {
    for (let c = 0; c < row.childCount; c++) {
      const cell = row.child(c);
      cell.forEach((child) => {
        if (child.type.name !== 'paragraph') hasComplex = true;
      });
    }
  }

  if (hasComplex) {
    serializeTableAsHtml(state, node, rows);
    return;
  }

  // Calculate column widths and alignments
  const colWidths: number[] = new Array(colCount).fill(3);
  const alignments: (string | null)[] = new Array(colCount).fill(null);

  // Get alignments from first row headers
  for (let c = 0; c < colCount; c++) {
    const cell = rows[0].child(c);
    alignments[c] = cell.attrs.alignment || null;
  }

  // Calculate max widths
  for (const row of rows) {
    for (let c = 0; c < Math.min(row.childCount, colCount); c++) {
      const text = row.child(c).textContent;
      colWidths[c] = Math.max(colWidths[c], text.length);
    }
  }

  // Render header row
  const headerRow = rows[0];
  const isHeader = headerRow.firstChild?.type.name === 'table_header';

  // When first row is NOT a header, emit a marker comment so parser can restore td state
  if (!isHeader) {
    state.write('<!-- no-header -->\n');
  }

  function cellHasComplexContent(cell: ProsemirrorNode): boolean {
    let complex = false;
    cell.forEach((child) => {
      if (child.type.name !== 'paragraph') complex = true;
    });
    return complex;
  }

  // Serialize inline marks to clean HTML (GitLab-compatible, no classes/data-attrs)
  function serializeMarksOpen(marks: readonly Mark[]): string {
    let html = '';
    for (const m of marks) {
      switch (m.type.name) {
        case 'strong': html += '<strong>'; break;
        case 'em': html += '<em>'; break;
        case 'underline': html += '<u>'; break;
        case 'strikethrough': html += '<del>'; break;
        case 'code_inline': html += '<code>'; break;
        case 'highlight': html += '<mark>'; break;
        case 'link': html += `<a href="${escHtml(m.attrs.href)}">`; break;
        case 'html_tag': html += `<${m.attrs.tag}>`; break;
      }
    }
    return html;
  }

  function serializeMarksClose(marks: readonly Mark[]): string {
    let html = '';
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      switch (m.type.name) {
        case 'strong': html += '</strong>'; break;
        case 'em': html += '</em>'; break;
        case 'underline': html += '</u>'; break;
        case 'strikethrough': html += '</del>'; break;
        case 'code_inline': html += '</code>'; break;
        case 'highlight': html += '</mark>'; break;
        case 'link': html += '</a>'; break;
        case 'html_tag': html += `</${m.attrs.tag}>`; break;
      }
    }
    return html;
  }

  function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Serialize inline content of a node to clean HTML
  function serializeInlineHtml(node: ProsemirrorNode): string {
    let html = '';
    node.forEach((child) => {
      if (child.isText) {
        html += serializeMarksOpen(child.marks);
        html += escHtml(child.text || '');
        html += serializeMarksClose(child.marks);
      } else if (child.type.name === 'hard_break') {
        html += '<br>';
      } else if (child.type.name === 'image') {
        const { src, originalSrc, alt, title } = child.attrs;
        const u = originalSrc || src || '';
        html += `<img src="${escHtml(u)}"${alt ? ` alt="${escHtml(alt)}"` : ''}${title ? ` title="${escHtml(title)}"` : ''}>`;
      } else if (child.type.name === 'html_inline') {
        html += child.attrs.html || '';
      }
    });
    return html;
  }

  // Serialize a block node to clean, GitLab-compatible HTML (no classes, no data-attrs)
  function nodeToCleanHtml(node: ProsemirrorNode): string {
    switch (node.type.name) {
      case 'paragraph':
        return `<p>${serializeInlineHtml(node)}</p>`;
      case 'heading':
        return `<h${node.attrs.level}>${serializeInlineHtml(node)}</h${node.attrs.level}>`;
      case 'blockquote': {
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<blockquote>${inner}</blockquote>`;
      }
      case 'bullet_list': {
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<ul>${inner}</ul>`;
      }
      case 'ordered_list': {
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        const start = node.attrs.order !== 1 ? ` start="${node.attrs.order}"` : '';
        return `<ol${start}>${inner}</ol>`;
      }
      case 'list_item': {
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<li>${inner}</li>`;
      }
      case 'checkbox_list': {
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<ul>${inner}</ul>`;
      }
      case 'checkbox_item': {
        const checked = node.attrs.checked ? ' checked' : '';
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<li><input type="checkbox"${checked} disabled>${inner}</li>`;
      }
      case 'notice': {
        // Blockquote with [!type] marker so it round-trips and GitLab shows the type
        const style = node.attrs.style || 'note';
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<blockquote><p>[!${escHtml(style)}]</p>${inner}</blockquote>`;
      }
      case 'code_block': {
        const lang = node.attrs.language ? ` class="language-${escHtml(node.attrs.language)}"` : '';
        return `<pre><code${lang}>${escHtml(node.textContent)}</code></pre>`;
      }
      case 'horizontal_rule':
        return '<hr>';
      case 'details': {
        const summary = escHtml(node.attrs.summary || 'Details');
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return `<details><summary>${summary}</summary>${inner}</details>`;
      }
      default: {
        // Fallback: serialize children
        if (node.isTextblock) {
          return `<p>${serializeInlineHtml(node)}</p>`;
        }
        let inner = '';
        node.forEach((child) => { inner += nodeToCleanHtml(child); });
        return inner;
      }
    }
  }

  function serializeCellAsHtml(cell: ProsemirrorNode): string {
    let html = '';
    cell.forEach((child) => {
      html += nodeToCleanHtml(child);
    });
    // Single line, escape pipes for markdown table syntax
    return html.replace(/\n/g, '').replace(/\|/g, '&#124;');
  }

  function serializeCellContent(cell: ProsemirrorNode): string {
    // If cell has complex content (lists, notices, etc.), serialize as HTML
    if (cellHasComplexContent(cell)) {
      return serializeCellAsHtml(cell);
    }

    // Serialize inline content with marks preserved
    const tempSerializer = new MarkdownSerializer(
      {
        doc(s, n) { s.renderContent(n); },
        paragraph(s, n) { s.renderInline(n); },
        text(s, n) { s.text(n.text || ''); },
        hard_break(s) { s.write(' '); },
        image(s, n) { s.write(`![${n.attrs.alt || ''}](${formatUrl(n.attrs.originalSrc || n.attrs.src || '')})`); },
        html_inline(s, n) { s.text(n.attrs.html, false); },
        footnote_ref(s, n) { s.write(`[^${n.attrs.label || '1'}]`); },
        math_inline(s, n) { s.write('$'); s.text(n.textContent, false); s.write('$'); },
        math_block(s, n) { s.write('$$'); s.text(n.textContent, false); s.write('$$'); },
        video(s, n) { s.write(`[Video](${n.attrs.src || ''})`); },
        audio(s, n) { s.write(`[Audio](${n.attrs.src || ''})`); },
      } as any,
      markSerializers as any
    );
    // Cell content is block+ — recursively collect inline content from all blocks
    const parts: string[] = [];
    function collectInline(node: ProsemirrorNode) {
      node.forEach((child) => {
        if (child.isTextblock) {
          const content = tempSerializer.serialize(child.type.schema.node('doc', null, [child])).trim();
          if (content) parts.push(content);
        } else if (child.isBlock) {
          // Recurse into block containers (notice, blockquote, list, etc.)
          collectInline(child);
        }
      });
    }
    collectInline(cell);
    return parts.join(' ');
  }

  function renderRow(row: ProsemirrorNode) {
    state.write('|');
    for (let c = 0; c < Math.min(row.childCount, colCount); c++) {
      const text = serializeCellContent(row.child(c));
      state.write(` ${text.padEnd(colWidths[c])} |`);
    }
    state.write('\n');
  }

  renderRow(headerRow);

  // Render separator
  state.write('|');
  for (let c = 0; c < colCount; c++) {
    const width = colWidths[c];
    const align = alignments[c];
    let sep = '-'.repeat(width);
    if (align === 'center') {
      sep = ':' + '-'.repeat(Math.max(1, width - 2)) + ':';
    } else if (align === 'right') {
      sep = '-'.repeat(Math.max(1, width - 1)) + ':';
    } else if (align === 'left') {
      sep = ':' + '-'.repeat(Math.max(1, width - 1));
    }
    state.write(` ${sep.padEnd(colWidths[c])} |`);
  }
  state.write('\n');

  // Render data rows
  for (let r = 1; r < rows.length; r++) {
    renderRow(rows[r]);
  }

  state.closeBlock(node);
}

function serializeHtmlBlock(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.text(node.attrs.html, false);
  state.closeBlock(node);
}

function serializeHtmlInline(state: MarkdownSerializerState, node: ProsemirrorNode) {
  state.text(node.attrs.html, false);
}

function serializeHardBreak(state: MarkdownSerializerState) {
  state.write('\\\n');
}

function serializeFrontmatter(state: MarkdownSerializerState, node: ProsemirrorNode) {
  const yamlText = node.textContent;
  state.write('---\n');
  state.text(yamlText, false);
  state.write('\n---');
  state.closeBlock(node);
}

// ─── Mark Serializers ──────────────────────────────────────────────────────

const markSerializers = {
  strong: {
    open: '**',
    close: '**',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  em: {
    open: '*',
    close: '*',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  underline: {
    open: '__',
    close: '__',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  strikethrough: {
    open: '~~',
    close: '~~',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  code_inline: {
    open(_state: MarkdownSerializerState, _mark: Mark, parent: ProsemirrorNode, index: number) {
      // Check if child exists at this index
      if (index >= parent.childCount) {
        return '`';
      }
      const content = parent.child(index).text || '';
      const backtickCount = Math.max(...(content.match(/`+/g) || ['']).map((s: string) => s.length)) + 1;
      const ticks = '`'.repeat(Math.max(1, backtickCount));
      return content.startsWith('`') ? ticks + ' ' : ticks;
    },
    close(_state: MarkdownSerializerState, _mark: Mark, parent: ProsemirrorNode, index: number) {
      // Check if child exists at this index
      if (index >= parent.childCount) {
        return '`';
      }
      const content = parent.child(index).text || '';
      const backtickCount = Math.max(...(content.match(/`+/g) || ['']).map((s: string) => s.length)) + 1;
      const ticks = '`'.repeat(Math.max(1, backtickCount));
      return content.endsWith('`') ? ' ' + ticks : ticks;
    },
    escape: false,
  },
  highlight: {
    open: '==',
    close: '==',
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  link: {
    open(_state: MarkdownSerializerState, mark: Mark) {
      return '[';
    },
    close(state: MarkdownSerializerState, mark: Mark) {
      const href = mark.attrs.href || '';
      const title = mark.attrs.title ? ` "${state.esc(mark.attrs.title)}"` : '';
      return `](${formatUrl(href)}${title})`;
    },
  },
  diff_add: {
    open: '{+ ',
    close: ' +}',
  },
  diff_del: {
    open: '{- ',
    close: ' -}',
  },
  html_tag: {
    open(_state: MarkdownSerializerState, mark: Mark) {
      return mark.attrs.markup || `<${mark.attrs.tag}>`;
    },
    close(_state: MarkdownSerializerState, mark: Mark) {
      return `</${mark.attrs.tag}>`;
    },
  },
};

// ─── Create Serializer ─────────────────────────────────────────────────────

export const serializer = new MarkdownSerializer(
  {
    doc(state, node) {
      state.renderContent(node);
    },
    frontmatter: serializeFrontmatter,
    paragraph: serializeParagraph,
    heading: serializeHeading,
    blockquote: serializeBlockquote,
    code_block: serializeCodeBlock,
    horizontal_rule: serializeHorizontalRule,
    bullet_list: serializeBulletList,
    ordered_list: serializeOrderedList,
    list_item: serializeListItem,
    checkbox_list: serializeCheckboxList,
    checkbox_item: serializeCheckboxItem,
    notice: serializeNotice,
    details: serializeDetails,
    image: serializeImage,
    table: serializeTable,
    table_row: () => {}, // handled by table
    table_cell: () => {}, // handled by table
    table_header: () => {}, // handled by table
    description_list(state: MarkdownSerializerState, node: ProsemirrorNode) {
      state.renderContent(node);
    },
    description_term(state: MarkdownSerializerState, node: ProsemirrorNode) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    description_detail(state: MarkdownSerializerState, node: ProsemirrorNode) {
      state.wrapBlock('    ', ':   ', node, () => state.renderContent(node));
    },
    footnote_ref(state: MarkdownSerializerState, node: ProsemirrorNode) {
      const label = node.attrs.label || '1';
      state.write(`[^${label}]`);
    },
    footnote_def(state: MarkdownSerializerState, node: ProsemirrorNode) {
      const label = node.attrs.label || '1';
      state.wrapBlock('    ', `[^${label}]: `, node, () => state.renderContent(node));
    },
    video(state: MarkdownSerializerState, node: ProsemirrorNode) {
      const alt = state.esc(node.attrs.alt || '');
      const src = node.attrs.originalSrc || node.attrs.src || '';
      const title = node.attrs.title ? ` "${state.esc(node.attrs.title)}"` : '';
      state.write(`![${alt}](${formatUrl(src)}${title})`);
    },
    audio(state: MarkdownSerializerState, node: ProsemirrorNode) {
      const alt = state.esc(node.attrs.alt || '');
      const src = node.attrs.originalSrc || node.attrs.src || '';
      const title = node.attrs.title ? ` "${state.esc(node.attrs.title)}"` : '';
      state.write(`![${alt}](${formatUrl(src)}${title})`);
    },
    table_of_contents(state: MarkdownSerializerState, node: ProsemirrorNode) {
      state.write('[[_TOC_]]');
      state.closeBlock(node);
    },
    math_inline(state: MarkdownSerializerState, node: ProsemirrorNode) {
      state.write('$');
      state.text(node.textContent, false);
      state.write('$');
    },
    math_block(state: MarkdownSerializerState, node: ProsemirrorNode) {
      state.write('$$\n');
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write('$$');
      state.closeBlock(node);
    },
    html_block: serializeHtmlBlock,
    html_inline: serializeHtmlInline,
    hard_break: serializeHardBreak,
    text(state, node) {
      state.text(node.text || '');
    },
  },
  markSerializers as any
);

/**
 * Serialize a ProseMirror document to Markdown.
 */
export function docToMarkdown(doc: ProsemirrorNode): string {
  return serializer.serialize(doc, { tightLists: true });
}
