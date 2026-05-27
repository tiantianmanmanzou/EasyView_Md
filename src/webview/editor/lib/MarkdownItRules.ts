/**
 * Custom markdown-it rule registrations for InLineMd.
 *
 * Registers inline, block and core rules that extend the default markdown-it
 * behaviour:  highlight, underline, fenced_blockquote, notice, diff_inline,
 * math_inline, math_block, table_of_contents, image_dimensions, media_detect,
 * checkboxes, details_blocks, html_inline_tags, footnote_cleanup.
 */

import type MarkdownIt from 'markdown-it';

// ─── Regex constants ─────────────────────────────────────────────────────────

const ALERT_RE = /^>\s*\[!(note|tip|important|caution|warning)\]\s*$/i;
const ATTR_RE = /^\{([^}]+)\}/;
const DIM_KV = /(?:width|height)\s*=\s*"?([^"\s}]+)"?/gi;
const VIDEO_EXTS = /\.(mp4|m4v|mov|webm|ogv)(\?[^)]*)?$/i;
const AUDIO_EXTS = /\.(mp3|oga|ogg|spx|wav|flac|aac|m4a)(\?[^)]*)?$/i;
const KNOWN_INLINE_TAGS = new Set(['kbd', 'sub', 'sup', 'abbr', 'var', 'samp', 'small', 'ruby', 'rt', 'rp']);

// ─── Public API ──────────────────────────────────────────────────────────────

export function applyCustomRules(md: MarkdownIt): void {
  // Cleanup: strip footnote_block wrappers and footnote_anchor back-links
  // so prosemirror-markdown sees footnote_open/close as direct block tokens
  md.core.ruler.push('footnote_cleanup', (state) => {
    state.tokens = state.tokens.filter(t =>
      t.type !== 'footnote_block_open' &&
      t.type !== 'footnote_block_close' &&
      t.type !== 'footnote_anchor'
    );
    // Also strip footnote_anchor from inline children (safety net)
    for (const token of state.tokens) {
      if (token.children) {
        token.children = token.children.filter((c: any) => c.type !== 'footnote_anchor');
      }
    }
  });

  // Custom: highlight ==text==
  md.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
    const start = state.pos;
    const max = state.posMax;
    if (state.src.charCodeAt(start) !== 0x3D /* = */ || state.src.charCodeAt(start + 1) !== 0x3D) {
      return false;
    }

    const end = state.src.indexOf('==', start + 2);
    if (end === -1 || end >= max) return false;

    // Always advance state.pos — skipToken requires it even in silent mode
    state.pos = end + 2;
    if (silent) return true;

    const token = state.push('highlight_open', 'mark', 1);
    token.markup = '==';

    const content = state.src.slice(start + 2, end);
    const textToken = state.push('text', '', 0);
    textToken.content = content;

    const closeToken = state.push('highlight_close', 'mark', -1);
    closeToken.markup = '==';
    return true;
  });

  // Custom: underline __text__ — intercept before emphasis handles it as strong
  md.inline.ruler.before('emphasis', 'underline', (state, silent) => {
    const start = state.pos;
    const max = state.posMax;
    if (state.src.charCodeAt(start) !== 0x5F /* _ */ || state.src.charCodeAt(start + 1) !== 0x5F) {
      return false;
    }
    // Must not be followed by another _ (that would be ___ = strong+em)
    if (state.src.charCodeAt(start + 2) === 0x5F) return false;

    const end = state.src.indexOf('__', start + 2);
    if (end === -1 || end >= max) return false;

    // Always advance state.pos — skipToken requires it even in silent mode
    state.pos = end + 2;
    if (silent) return true;

    const token = state.push('underline_open', 'u', 1);
    token.markup = '__';

    const content = state.src.slice(start + 2, end);
    const textToken = state.push('text', '', 0);
    textToken.content = content;

    const closeToken = state.push('underline_close', 'u', -1);
    closeToken.markup = '__';
    return true;
  });

  // Custom: GitLab fenced blockquotes >>>...>>>
  md.block.ruler.before('blockquote', 'fenced_blockquote', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const firstLine = state.src.slice(pos, max).trim();

    if (firstLine !== '>>>') return false;
    if (silent) return true;

    // Find closing >>>
    let nextLine = startLine + 1;
    let found = false;
    while (nextLine < endLine) {
      const linePos = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const line = state.src.slice(linePos, lineMax).trim();
      if (line === '>>>') {
        found = true;
        break;
      }
      nextLine++;
    }

    if (!found) return false;

    // Collect content between >>> markers
    const contentLines: string[] = [];
    for (let l = startLine + 1; l < nextLine; l++) {
      const linePos = state.bMarks[l] + state.tShift[l];
      const lineMax = state.eMarks[l];
      contentLines.push(state.src.slice(linePos, lineMax));
    }

    const openToken = state.push('blockquote_open', 'blockquote', 1);
    openToken.map = [startLine, nextLine + 1];

    // Parse inner content
    const innerContent = contentLines.join('\n');
    if (innerContent.trim()) {
      const innerTokens = state.md.parse(innerContent, state.env);
      for (const token of innerTokens) {
        const t = state.push(token.type, token.tag, token.nesting);
        t.content = token.type === 'inline' ? '' : token.content;
        t.children = token.children;
        t.attrs = token.attrs;
        t.map = token.map;
        t.markup = token.markup;
        t.info = token.info;
        t.meta = token.meta;
        t.block = token.block;
        t.hidden = token.hidden;
        t.level = token.level;
      }
    }

    state.push('blockquote_close', 'blockquote', -1);
    state.line = nextLine + 1;
    return true;
  });

  // Custom: GitLab-style alerts  > [!note] / > [!tip] / > [!important] / > [!caution] / > [!warning]
  md.block.ruler.before('blockquote', 'notice', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const firstLine = state.src.slice(pos, max);

    const match = ALERT_RE.exec(firstLine);
    if (!match) return false;
    if (silent) return true;

    const style = match[1].toLowerCase();

    // Collect content lines that start with "> " or are empty ">"
    let nextLine = startLine + 1;
    const contentLines: string[] = [];
    while (nextLine < endLine) {
      const linePos = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const line = state.src.slice(linePos, lineMax);

      // Line must start with ">" to continue the blockquote
      if (!line.startsWith('>')) break;

      // Strip "> " or ">" prefix
      const stripped = line.replace(/^>\s?/, '');
      contentLines.push(stripped);
      nextLine++;
    }

    const openToken = state.push('notice_open', 'div', 1);
    openToken.attrSet('data-style', style);
    openToken.attrSet('class', `notice-block notice-${style}`);
    openToken.map = [startLine, nextLine];

    // Parse inner content by injecting stripped lines into state
    const innerContent = contentLines.join('\n');
    if (innerContent.trim()) {
      // Use a child state to tokenize the inner content
      const innerTokens = state.md.parse(innerContent, state.env);
      for (const token of innerTokens) {
        const t = state.push(token.type, token.tag, token.nesting);
        // For inline tokens: keep already-processed children from inner parse
        // and clear content so the main inline rule won't re-parse them.
        // (Inner parse already ran checkboxes/etc. core rules on children.)
        t.content = token.type === 'inline' ? '' : token.content;
        t.children = token.children;
        t.attrs = token.attrs;
        t.map = token.map;
        t.markup = token.markup;
        t.info = token.info;
        t.meta = token.meta;
        t.block = token.block;
        t.hidden = token.hidden;
        t.level = token.level;
      }
    }

    state.push('notice_close', 'div', -1);
    state.line = nextLine;
    return true;
  });

  // Custom: GitLab inline diff {+ added +} / {- removed -} / [+ added +] / [- removed -]
  md.inline.ruler.before('emphasis', 'diff_inline', (state, silent) => {
    const start = state.pos;
    const max = state.posMax;
    if (start + 4 > max) return false; // minimum: {+x+}

    const c0 = state.src.charCodeAt(start);
    const c1 = state.src.charCodeAt(start + 1);

    // Detect opening: {+ or {- or [+ or [-
    let markType: 'add' | 'del' | null = null;
    let openBrace: number; // char code for { or [
    let closeBrace: string; // closing sequence: +} or -} or +] or -]

    if ((c0 === 0x7B /* { */ || c0 === 0x5B /* [ */) && (c1 === 0x2B /* + */ || c1 === 0x2D /* - */)) {
      markType = c1 === 0x2B ? 'add' : 'del';
      openBrace = c0;
      const closeChar = c0 === 0x7B ? '}' : ']';
      const signChar = c1 === 0x2B ? '+' : '-';
      closeBrace = signChar + closeChar;
    } else {
      return false;
    }

    // Find closing sequence
    const contentStart = start + 2;
    let end = state.src.indexOf(closeBrace, contentStart);
    if (end === -1 || end >= max) return false;

    // Must have non-empty content
    const content = state.src.slice(contentStart, end);
    if (!content.trim()) return false;

    // Always advance state.pos — skipToken requires it even in silent mode
    state.pos = end + 2;
    if (silent) return true;

    const tokenType = markType === 'add' ? 'diff_add' : 'diff_del';
    const tag = markType === 'add' ? 'ins' : 'del';

    const openToken = state.push(tokenType + '_open', tag, 1);
    openToken.markup = state.src.slice(start, start + 2);

    // Strip leading/trailing space from content (GitLab ignores them)
    const trimmed = content.replace(/^ /, '').replace(/ $/, '');
    const textToken = state.push('text', '', 0);
    textToken.content = trimmed;

    const closeToken = state.push(tokenType + '_close', tag, -1);
    closeToken.markup = closeBrace;
    return true;
  });

  // Custom: inline math $...$
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;

    // Check for valid opening delimiter
    const max = state.posMax;
    const prevChar = state.pos > 0 ? state.src.charCodeAt(state.pos - 1) : -1;
    const nextChar = state.pos + 1 <= max ? state.src.charCodeAt(state.pos + 1) : -1;

    // Not a valid open if preceded by non-whitespace and next is digit
    if ((nextChar >= 0x30 && nextChar <= 0x39)) return false;
    // Not a valid open if next char is whitespace or another $
    if (nextChar === 0x20 || nextChar === 0x09 || nextChar === 0x24) return false;

    const start = state.pos + 1;
    let match = start;
    while ((match = state.src.indexOf('$', match)) !== -1) {
      // Check for escapes
      let pos = match - 1;
      while (pos >= 0 && state.src[pos] === '\\') pos--;
      if ((match - pos) % 2 === 1) break; // even number of escapes
      match++;
    }

    if (match === -1) {
      if (!silent) state.pending += '$';
      state.pos = start;
      return true;
    }

    // Empty content $$
    if (match - start === 0) {
      if (!silent) state.pending += '$$';
      state.pos = start + 1;
      return true;
    }

    // Check valid closing — not preceded by whitespace
    const beforeClose = state.src.charCodeAt(match - 1);
    if (beforeClose === 0x20 || beforeClose === 0x09) {
      if (!silent) state.pending += '$';
      state.pos = start;
      return true;
    }

    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.markup = '$';
      token.content = state.src.slice(start, match);
    }

    state.pos = match + 1;
    return true;
  });

  // Custom: block math $$...$$
  md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];

    if (pos + 2 > max) return false;
    if (state.src.slice(pos, pos + 2) !== '$$') return false;

    if (silent) return true;

    const firstLine = state.src.slice(pos + 2, max);

    // Check for single-line: $$content$$
    if (firstLine.trim().endsWith('$$')) {
      const content = firstLine.trim().slice(0, -2);
      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = content;
      token.map = [startLine, startLine + 1];
      token.markup = '$$';
      state.line = startLine + 1;
      return true;
    }

    // Multi-line: find closing $$
    let found = false;
    let next = startLine;
    let lastLine = '';
    for (next = startLine + 1; next < endLine; next++) {
      const linePos = state.bMarks[next] + state.tShift[next];
      const lineMax = state.eMarks[next];
      const line = state.src.slice(linePos, lineMax).trim();

      if (line === '$$') {
        found = true;
        break;
      }
    }

    if (!found) return false;

    state.line = next + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content =
      (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
      state.getLines(startLine + 1, next, state.tShift[startLine], true).replace(/\n$/, '');
    token.map = [startLine, state.line];
    token.markup = '$$';
    return true;
  });

  // Convert ```math fenced code blocks to math_block tokens (GitLab compatibility)
  md.core.ruler.before('inline', 'math_fence', (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t.type === 'fence' && t.info?.trim() === 'math') {
        t.type = 'math_block';
        t.tag = 'math';
        t.info = '';
      }
    }
  });

  // Custom: [[_TOC_]] table of contents placeholder
  md.block.ruler.before('paragraph', 'table_of_contents', (state, startLine, _endLine, silent) => {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const line = state.src.slice(pos, max).trim();

    // Match [[_TOC_]] or [TOC] (case-insensitive)
    if (!/^\[\[_TOC_\]\]$/i.test(line) && !/^\[TOC\]$/i.test(line)) return false;
    if (silent) return true;

    const token = state.push('table_of_contents', 'div', 0);
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  });

  // Custom: parse image dimensions {width=X height=Y} after image tokens (GitLab syntax)
  md.core.ruler.after('inline', 'image_dimensions', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      const children = token.children;

      for (let i = 0; i < children.length - 1; i++) {
        const child = children[i];
        // Only process image/video/audio tokens
        if (child.type !== 'image' && child.type !== 'video' && child.type !== 'audio') continue;

        const next = children[i + 1];
        if (next.type !== 'text') continue;

        const match = next.content.match(ATTR_RE);
        if (!match) continue;

        const attrStr = match[1];
        let m;
        DIM_KV.lastIndex = 0;
        while ((m = DIM_KV.exec(attrStr)) !== null) {
          const key = m[0].split('=')[0].trim();
          const val = m[1];
          if (key === 'width') {
            child.attrSet('width', val);
          } else if (key === 'height') {
            child.attrSet('height', val);
          }
        }

        // Remove consumed {attrs} from text
        next.content = next.content.slice(match[0].length);
        if (!next.content) {
          children.splice(i + 1, 1);
        }
      }
    }
  });

  // Custom: auto-detect video/audio from image syntax by file extension
  md.core.ruler.after('inline', 'media_detect', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue;
      for (const child of token.children) {
        if (child.type !== 'image') continue;
        const src = child.attrGet('src') || '';
        if (VIDEO_EXTS.test(src)) {
          child.type = 'video';
        } else if (AUDIO_EXTS.test(src)) {
          child.type = 'audio';
        }
      }
    }
  });

  // Custom: checkbox lists
  md.core.ruler.after('inline', 'checkboxes', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline' || !tokens[i].children) continue;

      const children = tokens[i].children!;
      if (children.length === 0) continue;

      const firstChild = children[0];
      if (firstChild.type !== 'text') continue;

      const match = firstChild.content.match(/^\[([ xX~])\]\s*/);
      if (!match) continue;

      // Check parent is list_item
      let parentIdx = i - 1;
      while (parentIdx >= 0 && tokens[parentIdx].type !== 'list_item_open') {
        parentIdx--;
      }
      if (parentIdx < 0) continue;

      const c = match[1];
      const checked = c === '~' ? 'inapplicable' : c.toLowerCase() === 'x' ? 'true' : 'false';
      tokens[parentIdx].type = 'checkbox_item_open';
      tokens[parentIdx].attrSet('checked', checked);

      // Find closing tag
      let closeIdx = i + 1;
      while (closeIdx < tokens.length && tokens[closeIdx].type !== 'list_item_close') {
        closeIdx++;
      }
      if (closeIdx < tokens.length) {
        tokens[closeIdx].type = 'checkbox_item_close';
      }

      // Also mark parent list
      // Stop at both bullet_list_open AND checkbox_list_open — the latter means
      // a previous checkbox item already converted this list, so no re-conversion needed.
      let listIdx = parentIdx - 1;
      while (listIdx >= 0 && tokens[listIdx].type !== 'bullet_list_open' && tokens[listIdx].type !== 'checkbox_list_open') {
        listIdx--;
      }
      if (listIdx >= 0 && tokens[listIdx].type === 'bullet_list_open') {
        tokens[listIdx].type = 'checkbox_list_open';
        // Find matching close
        let depth = 1;
        for (let j = listIdx + 1; j < tokens.length; j++) {
          if (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'checkbox_list_open') depth++;
          if (tokens[j].type === 'bullet_list_close' || tokens[j].type === 'checkbox_list_close') {
            depth--;
            if (depth === 0) {
              tokens[j].type = 'checkbox_list_close';
              break;
            }
          }
        }
      }

      // Remove checkbox syntax from text
      firstChild.content = firstChild.content.slice(match[0].length);
    }
  });

  // Convert <details>/<summary> html_blocks into proper details container tokens
  md.core.ruler.before('inline', 'details_blocks', (state) => {
    const tokens = state.tokens;
    const newTokens: any[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];

      if (t.type === 'html_block') {
        const content = t.content.trim();

        // Case: self-contained <details>...</details> in one html_block
        const fullMatch = content.match(/^<details(\s[^>]*)?>([\s\S]*)<\/details>$/i);
        if (fullMatch) {
          const inner = fullMatch[2];
          const summaryMatch = inner.match(/<summary>([\s\S]*?)<\/summary>/i);
          const summary = summaryMatch ? summaryMatch[1].trim() : 'Details';
          let bodyContent = summaryMatch
            ? inner.slice(inner.indexOf('</summary>') + '</summary>'.length).trim()
            : inner.trim();

          const open = new state.Token('details_open', 'details', 1);
          open.attrSet('summary', summary);
          newTokens.push(open);

          if (bodyContent) {
            const innerTokens = state.md.parse(bodyContent, state.env);
            for (const it of innerTokens) {
              const nt = new state.Token(it.type, it.tag, it.nesting);
              // For inline tokens: keep already-processed children from inner parse
              // and clear content so the main inline rule won't re-parse them
              nt.content = it.type === 'inline' ? '' : it.content;
              nt.children = it.children;
              nt.attrs = it.attrs;
              nt.map = it.map;
              nt.markup = it.markup;
              nt.info = it.info;
              nt.meta = it.meta;
              nt.block = it.block;
              nt.hidden = it.hidden;
              nt.level = it.level;
              newTokens.push(nt);
            }
          } else {
            const pOpen = new state.Token('paragraph_open', 'p', 1);
            newTokens.push(pOpen);
            const inline = new state.Token('inline', '', 0);
            inline.content = '';
            inline.children = [];
            newTokens.push(inline);
            const pClose = new state.Token('paragraph_close', 'p', -1);
            newTokens.push(pClose);
          }

          const close = new state.Token('details_close', 'details', -1);
          newTokens.push(close);
          continue;
        }

        // Case: opening <details> tag only (split across multiple html_blocks)
        const openMatch = content.match(/^<details(\s[^>]*)?>[\s\S]*$/i);
        if (openMatch && !content.match(/<\/details>/i)) {
          const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/i);
          const summary = summaryMatch ? summaryMatch[1].trim() : 'Details';

          const open = new state.Token('details_open', 'details', 1);
          open.attrSet('summary', summary);
          newTokens.push(open);
          continue;
        }

        // Case: closing </details> tag
        if (content.match(/^<\/details>\s*$/i)) {
          const close = new state.Token('details_close', 'details', -1);
          newTokens.push(close);
          continue;
        }
      }

      newTokens.push(t);
    }

    state.tokens = newTokens;
  });

  // Convert known inline HTML tags to mark tokens for proper rendering
  md.core.ruler.after('inline', 'html_inline_tags', (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      if (state.tokens[i].type !== 'inline') continue;
      const children = state.tokens[i].children;
      if (!children) continue;

      const newChildren: any[] = [];
      for (const child of children) {
        if (child.type === 'html_inline') {
          if (/^<br\s*\/?>$/i.test(child.content.trim())) {
            const t = new state.Token('hardbreak', 'br', 0);
            t.markup = child.content;
            newChildren.push(t);
            continue;
          }
          // Try to match opening tag
          const openMatch = child.content.match(/^<([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*)?\s*>$/);
          if (openMatch && KNOWN_INLINE_TAGS.has(openMatch[1].toLowerCase())) {
            const t = new state.Token('html_tag_open', openMatch[1].toLowerCase(), 1);
            t.markup = child.content;
            newChildren.push(t);
            continue;
          }
          // Try to match closing tag
          const closeMatch = child.content.match(/^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/);
          if (closeMatch && KNOWN_INLINE_TAGS.has(closeMatch[1].toLowerCase())) {
            const t = new state.Token('html_tag_close', closeMatch[1].toLowerCase(), -1);
            t.markup = child.content;
            newChildren.push(t);
            continue;
          }
        }
        // Keep everything else as-is (including unrecognized html_inline)
        newChildren.push(child);
      }
      state.tokens[i].children = newChildren;
    }
  });
}
