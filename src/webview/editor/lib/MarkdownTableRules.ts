/**
 * Table-related markdown-it rules for InLineMd.
 *
 * Registers the `fix_tables` and `html_tables` core rules that normalise
 * markdown-it table tokens for ProseMirror consumption:
 *   - strip thead/tbody wrappers
 *   - wrap cell inline content in paragraphs
 *   - handle <!-- no-header --> markers
 *   - reconstruct HTML <table> blocks into proper table tokens
 */

import type MarkdownIt from 'markdown-it';

// ─── Helpers / constants ─────────────────────────────────────────────────────

const HTML_TABLE_TAG = /<\/?(?:table|thead|tbody|tfoot|tr|td|th)(?:\s[^>]*)?\s*>/gi;

/** Decode common HTML entities in cell text */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#124;/g, '|')
    .replace(/&nbsp;/g, '\u00A0');
}

/**
 * Emit paragraph-wrapped inline tokens for HTML cell content.
 * Handles <br> tags as hard breaks. For cells with complex inner HTML
 * (tags other than <br>), uses the <!--htmlcell--> marker so that
 * restoreHtmlCells() can parse them with ProseMirror DOMParser.
 */
function emitCellContent(cellHtml: string, out: any[], Token: any): void {
  // Check for complex HTML (tags other than <br>)
  const hasComplexHtml = /<(?!br\s*\/?\s*>|\/)([a-z])/i.test(cellHtml);

  out.push(new Token('paragraph_open', 'p', 1));

  const inline = new Token('inline', '', 0);

  if (hasComplexHtml) {
    // Use <!--htmlcell--> marker for restoreHtmlCells() post-processing
    const textTok = new Token('text', '', 0);
    textTok.content = '<!--htmlcell-->' + cellHtml;
    inline.children = [textTok];
    inline.content = textTok.content;
  } else {
    // Simple text, possibly with <br> tags
    inline.children = [];
    const parts = cellHtml.split(/<br\s*\/?>/i);
    const contentParts: string[] = [];
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        inline.children.push(new Token('hardbreak', 'br', 0));
      }
      const partText = decodeHtmlEntities(parts[p]);
      if (partText) {
        const textTok = new Token('text', '', 0);
        textTok.content = partText;
        inline.children.push(textTok);
        contentParts.push(partText);
      }
    }
    inline.content = contentParts.join('\n');
  }

  out.push(inline);
  out.push(new Token('paragraph_close', 'p', -1));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function applyTableRules(md: MarkdownIt): void {
  // Remove thead/tbody wrappers — ProseMirror expects table > tr directly
  // AND wrap table cell inline content in paragraphs (schema requires block+)
  // AND handle <!-- no-header --> marker: convert th → td for headerless tables
  md.core.ruler.after('inline', 'fix_tables', (state) => {
    // First pass: detect <!-- no-header --> markers before tables
    const noHeaderTables = new Set<number>();
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t.type === 'html_block' && t.content.trim() === '<!-- no-header -->') {
        // Find the next table_open after this marker
        for (let j = i + 1; j < state.tokens.length; j++) {
          if (state.tokens[j].type === 'table_open') {
            noHeaderTables.add(j);
            // Remove the html_block marker token
            state.tokens[i] = Object.assign(new state.Token('html_block', '', 0), { content: '', hidden: true });
            break;
          }
          // Stop if we hit a non-empty, non-whitespace token
          if (state.tokens[j].type !== 'html_block' || state.tokens[j].content.trim() !== '') break;
        }
      }
    }

    const newTokens: any[] = [];
    let insideNoHeaderTable = false;
    let inFirstRow = false;
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];

      // Skip hidden marker tokens
      if (t.hidden && t.type === 'html_block' && t.content === '') continue;

      // Track no-header tables
      if (t.type === 'table_open' && noHeaderTables.has(i)) {
        insideNoHeaderTable = true;
        inFirstRow = false;
      }
      if (t.type === 'table_close') {
        insideNoHeaderTable = false;
        inFirstRow = false;
      }

      // Track first row inside no-header table
      if (insideNoHeaderTable && t.type === 'tr_open' && !inFirstRow) {
        inFirstRow = true;
      } else if (insideNoHeaderTable && t.type === 'tr_close' && inFirstRow) {
        newTokens.push(t);
        inFirstRow = false;
        continue;
      }

      // Convert th → td in first row of no-header tables
      if (insideNoHeaderTable && inFirstRow) {
        if (t.type === 'th_open') {
          t.type = 'td_open';
          t.tag = 'td';
        } else if (t.type === 'th_close') {
          t.type = 'td_close';
          t.tag = 'td';
        }
      }

      // Skip thead/tbody wrappers
      if (['thead_open', 'thead_close', 'tbody_open', 'tbody_close'].includes(t.type)) {
        continue;
      }
      // Wrap inline content in td/th with paragraph
      if ((t.type === 'th_open' || t.type === 'td_open')) {
        newTokens.push(t);

        // Check if the next inline token has block-level HTML tags (complex cell content)
        const nextToken = state.tokens[i + 1];
        if (nextToken?.type === 'inline' && nextToken.children?.length) {
          const BLOCK_TAGS = /^<(ul|ol|li|blockquote|div|table|p|h[1-6]|pre|hr|dl|dt|dd|section|article|aside|nav|header|footer|figure|figcaption)[\s>/]/i;
          const hasBlockHtml = nextToken.children.some(
            (c: any) => c.type === 'html_inline' && BLOCK_TAGS.test(c.content)
          );
          if (hasBlockHtml) {
            // Reconstruct HTML from all inline children
            let html = '';
            for (const child of nextToken.children) {
              html += child.content;
            }
            // Replace inline children with a single text token holding the full HTML
            const textToken = new state.Token('text', '', 0);
            textToken.content = '<!--htmlcell-->' + html;
            nextToken.children = [textToken];
          }
        }

        // Add paragraph_open
        const pOpen = new state.Token('paragraph_open', 'p', 1);
        pOpen.level = t.level + 1;
        newTokens.push(pOpen);
        continue;
      }
      if ((t.type === 'th_close' || t.type === 'td_close')) {
        // Add paragraph_close before cell close
        const pClose = new state.Token('paragraph_close', 'p', -1);
        pClose.level = t.level + 1;
        newTokens.push(pClose);
        newTokens.push(t);
        continue;
      }
      newTokens.push(t);
    }
    state.tokens = newTokens;
  });

  // Reassemble HTML <table> blocks into proper table tokens.
  // markdown-it splits HTML tables with markdown cell content into:
  //   html_block("<table>\n<tr>\n<td>\n"), markdown tokens, html_block("</td>\n..."), ...
  // This rule reconstructs proper table_open/tr_open/td_open tokens from these fragments.
  // When the entire table is pure HTML (single html_block), we also extract cell text content.
  md.core.ruler.after('fix_tables', 'html_tables', (state) => {
    const tokens = state.tokens;
    const newTokens: any[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      // Detect html_block starting an HTML table
      if (t.type === 'html_block' && /<table[\s>]/i.test(t.content)) {
        // Process tokens from here until </table>
        let j = i;
        while (j < tokens.length) {
          const cur = tokens[j];
          if (cur.type === 'html_block') {
            // Extract tags and cell content from the HTML block
            const content = cur.content;
            HTML_TABLE_TAG.lastIndex = 0;
            let m;
            // Track position after the last cell-opening tag to extract cell text
            let cellOpenEndPos = -1;
            while ((m = HTML_TABLE_TAG.exec(content)) !== null) {
              const tagStr = m[0];
              const tagStartPos = m.index;
              const isClose = tagStr.startsWith('</');
              const tagName = tagStr.match(/<\/?(\w+)/)?.[1]?.toLowerCase();
              if (!tagName) continue;

              // Skip thead/tbody/tfoot wrappers
              if (['thead', 'tbody', 'tfoot'].includes(tagName)) continue;

              if (tagName === 'table') {
                newTokens.push(new state.Token(isClose ? 'table_close' : 'table_open', 'table', isClose ? -1 : 1));
              } else if (tagName === 'tr') {
                newTokens.push(new state.Token(isClose ? 'tr_close' : 'tr_open', 'tr', isClose ? -1 : 1));
              } else if (tagName === 'th' || tagName === 'td') {
                const tokenType = tagName === 'th' ? 'th' : 'td';
                if (isClose) {
                  // Extract cell text content between opening and closing tags
                  if (cellOpenEndPos >= 0) {
                    const cellHtml = content.slice(cellOpenEndPos, tagStartPos).trim();
                    if (cellHtml) {
                      emitCellContent(cellHtml, newTokens, state.Token);
                    } else {
                      // Empty cell — still needs a paragraph for schema compliance (block+)
                      newTokens.push(new state.Token('paragraph_open', 'p', 1));
                      const inline = new state.Token('inline', '', 0);
                      inline.children = [];
                      inline.content = '';
                      newTokens.push(inline);
                      newTokens.push(new state.Token('paragraph_close', 'p', -1));
                    }
                    cellOpenEndPos = -1;
                  }
                  newTokens.push(new state.Token(tokenType + '_close', tagName, -1));
                } else {
                  const tok = new state.Token(tokenType + '_open', tagName, 1);
                  const alignMatch = tagStr.match(/align="(\w+)"/i);
                  if (alignMatch) {
                    tok.attrSet('style', `text-align:${alignMatch[1]}`);
                  }
                  newTokens.push(tok);
                  // Mark position right after opening tag to capture cell content
                  cellOpenEndPos = m.index + tagStr.length;
                }
              }
            }

            if (/<\/table>/i.test(content)) {
              i = j;
              break;
            }
          } else {
            // Cell content — already properly tokenized by markdown-it
            newTokens.push(cur);
          }
          j++;
        }
        continue;
      }

      newTokens.push(t);
    }
    state.tokens = newTokens;
  });
}
