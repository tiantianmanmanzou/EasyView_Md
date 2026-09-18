/**
 * Table-related markdown-it rules for EasyView_Md.
 *
 * Normalises native GFM table tokens for ProseMirror consumption:
 *   - strip thead/tbody wrappers
 *   - wrap cell inline content in paragraphs
 *   - handle <!-- no-header --> markers
 *   - route complex inline HTML in GFM cells through <!--htmlcell--> markers
 *
 * Top-level HTML `<table>` blocks are handled separately by HtmlTableParser.
 */

import type MarkdownIt from 'markdown-it';

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

function normalizeEscapedInlineMarkdown(text: string): string {
  return text
    .replace(/(?:\\)+\*/g, '*')
    .replace(/(?:\\)+_/g, '_')
    .replace(/(?:\\)+~/g, '~')
    .replace(/\\\*\\\*([\s\S]+?)\\\*\\\*/g, '**$1**')
    .replace(/\\_\\_([\s\S]+?)\\_\\_/g, '__$1__')
    .replace(/\\~\\~([\s\S]+?)\\~\\~/g, '~~$1~~')
    .replace(/(^|[^\*\\])\\\*([^\s*][\s\S]*?[^\s*])\\\*(?!\*)/g, '$1*$2*')
    .replace(/(^|[^_\\])\\_([^\s_][\s\S]*?[^\s_])\\_(?!_)/g, '$1_$2_');
}

export function applyTableRules(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'fix_tables', (state) => {
    const noHeaderTables = new Set<number>();
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t.type === 'html_block' && t.content.trim() === '<!-- no-header -->') {
        for (let j = i + 1; j < state.tokens.length; j++) {
          if (state.tokens[j].type === 'table_open') {
            noHeaderTables.add(j);
            state.tokens[i] = Object.assign(new state.Token('html_block', '', 0), { content: '', hidden: true });
            break;
          }
          if (state.tokens[j].type !== 'html_block' || state.tokens[j].content.trim() !== '') break;
        }
      }
    }

    const newTokens: any[] = [];
    let insideNoHeaderTable = false;
    let inFirstRow = false;
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];

      if (t.hidden && t.type === 'html_block' && t.content === '') continue;

      if (t.type === 'table_open' && noHeaderTables.has(i)) {
        insideNoHeaderTable = true;
        inFirstRow = false;
      }
      if (t.type === 'table_close') {
        insideNoHeaderTable = false;
        inFirstRow = false;
      }

      if (insideNoHeaderTable && t.type === 'tr_open' && !inFirstRow) {
        inFirstRow = true;
      } else if (insideNoHeaderTable && t.type === 'tr_close' && inFirstRow) {
        newTokens.push(t);
        inFirstRow = false;
        continue;
      }

      if (insideNoHeaderTable && inFirstRow) {
        if (t.type === 'th_open') {
          t.type = 'td_open';
          t.tag = 'td';
        } else if (t.type === 'th_close') {
          t.type = 'td_close';
          t.tag = 'td';
        }
      }

      if (['thead_open', 'thead_close', 'tbody_open', 'tbody_close'].includes(t.type)) {
        continue;
      }

      if (t.type === 'th_open' || t.type === 'td_open') {
        newTokens.push(t);

        const nextToken = state.tokens[i + 1];
        if (nextToken?.type === 'inline' && nextToken.children?.length) {
          const BLOCK_TAGS =
            /^<(ul|ol|li|blockquote|div|table|p|h[1-6]|pre|hr|dl|dt|dd|section|article|aside|nav|header|footer|figure|figcaption)[\s>/]/i;
          const hasBlockHtml = nextToken.children.some(
            (c: any) => c.type === 'html_inline' && BLOCK_TAGS.test(c.content),
          );
          if (hasBlockHtml) {
            let html = '';
            for (const child of nextToken.children) {
              html += child.content;
            }
            const textToken = new state.Token('text', '', 0);
            textToken.content = '<!--htmlcell-->' + html;
            nextToken.children = [textToken];
          } else {
            for (const child of nextToken.children) {
              if (child.type === 'text' && child.content) {
                child.content = normalizeEscapedInlineMarkdown(decodeHtmlEntities(child.content));
              }
            }
          }
        }

        const pOpen = new state.Token('paragraph_open', 'p', 1);
        if (t.map) pOpen.map = t.map;
        pOpen.level = t.level + 1;
        newTokens.push(pOpen);
        continue;
      }

      if (t.type === 'th_close' || t.type === 'td_close') {
        const pClose = new state.Token('paragraph_close', 'p', -1);
        if (t.map) pClose.map = t.map;
        pClose.level = t.level + 1;
        newTokens.push(pClose);
        newTokens.push(t);
        continue;
      }

      newTokens.push(t);
    }
    state.tokens = newTokens;
  });
}
