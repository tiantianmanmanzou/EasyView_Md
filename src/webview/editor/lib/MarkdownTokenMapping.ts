/**
 * Token-to-ProseMirror mapping for InLineMd.
 *
 * Maps markdown-it token types to ProseMirror node and mark definitions
 * used by prosemirror-markdown's MarkdownParser.
 */

export const tokenMapping: Record<string, any> = {
  // Blocks
  paragraph: { block: 'paragraph' },
  blockquote: { block: 'blockquote' },
  heading: {
    block: 'heading',
    getAttrs(token: any) {
      return { level: parseInt(token.tag.slice(1), 10) };
    },
  },
  hr: { node: 'horizontal_rule' },
  code_block: {
    block: 'code_block',
    getAttrs() {
      return { language: '' };
    },
  },
  fence: {
    block: 'code_block',
    getAttrs(token: any) {
      return { language: token.info?.trim() || '' };
    },
  },
  bullet_list: { block: 'bullet_list' },
  ordered_list: {
    block: 'ordered_list',
    getAttrs(token: any) {
      return { order: token.attrGet('start') ? parseInt(token.attrGet('start'), 10) : 1 };
    },
  },
  list_item: { block: 'list_item' },
  checkbox_list: { block: 'checkbox_list' },
  checkbox_item: {
    block: 'checkbox_item',
    getAttrs(token: any) {
      const val = token.attrGet('checked');
      return { checked: val === 'inapplicable' ? 'inapplicable' : val === 'true' };
    },
  },
  notice: {
    block: 'notice',
    getAttrs(token: any) {
      return { style: token.attrGet('data-style') || 'note' };
    },
  },
  details: {
    block: 'details',
    getAttrs(token: any) {
      return { summary: token.attrGet('summary') || 'Details' };
    },
  },
  table: { block: 'table' },
  tr: { block: 'table_row' },
  th: {
    block: 'table_header',
    getAttrs(token: any) {
      return { alignment: token.attrGet('style')?.match(/text-align:(\w+)/)?.[1] || null };
    },
  },
  td: {
    block: 'table_cell',
    getAttrs(token: any) {
      return { alignment: token.attrGet('style')?.match(/text-align:(\w+)/)?.[1] || null };
    },
  },
  image: {
    node: 'image',
    getAttrs(token: any) {
      return {
        src: token.attrGet('src') || '',
        alt: token.children?.[0]?.content || token.attrGet('alt') || null,
        title: token.attrGet('title') || null,
        width: token.attrGet('width') || null,
        height: token.attrGet('height') || null,
      };
    },
  },
  dl: { block: 'description_list' },
  dt: { block: 'description_term' },
  dd: { block: 'description_detail' },
  video: {
    node: 'video',
    getAttrs(token: any) {
      return {
        src: token.attrGet('src') || '',
        alt: token.children?.[0]?.content || token.attrGet('alt') || null,
        title: token.attrGet('title') || null,
      };
    },
  },
  audio: {
    node: 'audio',
    getAttrs(token: any) {
      return {
        src: token.attrGet('src') || '',
        alt: token.children?.[0]?.content || token.attrGet('alt') || null,
        title: token.attrGet('title') || null,
      };
    },
  },
  table_of_contents: { node: 'table_of_contents' },
  math_inline: { block: 'math_inline', noCloseToken: true },
  math_block: { block: 'math_block', noCloseToken: true },
  footnote_ref: {
    node: 'footnote_ref',
    getAttrs(token: any) {
      return { label: token.meta?.label || String((token.meta?.id ?? 0) + 1) };
    },
  },
  footnote: {
    block: 'footnote_def',
    getAttrs(token: any) {
      return { label: token.meta?.label || String((token.meta?.id ?? 0) + 1) };
    },
  },
  // Safety: ignore footnote_anchor if cleanup rule misses it (prevents parser crash)
  footnote_anchor: { ignore: true },
  hardbreak: { node: 'hard_break' },
  softbreak: { node: 'hard_break' },

  // Inline marks
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strikethrough' },
  code_inline: { mark: 'code_inline', noCloseToken: true },
  link: {
    mark: 'link',
    getAttrs(token: any) {
      // Decode URI: markdown-it URL-encodes Cyrillic/Unicode characters,
      // but we want to store the readable form (e.g. #h-введение not #h-%D0%B2%D0%B2%D0%B5...)
      let href = token.attrGet('href') || '';
      try { href = decodeURI(href); } catch { /* keep encoded if invalid */ }
      return {
        href,
        title: token.attrGet('title') || null,
      };
    },
  },
  highlight: { mark: 'highlight' },
  underline: { mark: 'underline' },
  diff_add: { mark: 'diff_add' },
  diff_del: { mark: 'diff_del' },

  // HTML support — preserve raw HTML through round-trips
  html_block: {
    node: 'html_block',
    getAttrs(token: any) {
      return { html: token.content };
    },
  },
  html_inline: {
    node: 'html_inline',
    getAttrs(token: any) {
      return { html: token.content };
    },
  },
  html_tag: {
    mark: 'html_tag',
    getAttrs(token: any) {
      return { tag: token.tag, markup: token.markup || null };
    },
  },
};
