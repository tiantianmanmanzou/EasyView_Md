/**
 * Content processing functions for HTML export.
 *
 * Handles Mermaid blocks, math rendering, HTML comments, footnotes, and TOC blocks.
 */

import katex from 'katex';

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

/**
 * Process mermaid code blocks: convert them to <pre class="mermaid" data-source="...">
 * so the embedded JS can render them with mermaid.js.
 */
export function processMermaidBlocks(container: HTMLElement): boolean {
  let hasMermaid = false;

  // Handle code_block nodes with language=mermaid (serialized as <pre class="... language-mermaid"><code>)
  const preElements = container.querySelectorAll('pre');
  preElements.forEach((pre) => {
    const code = pre.querySelector('code');
    const className = (code?.className || '') + ' ' + (pre.className || '');
    if (className.includes('language-mermaid')) {
      const source = code?.textContent || pre.textContent || '';
      const mermaidPre = document.createElement('pre');
      mermaidPre.className = 'mermaid';
      mermaidPre.setAttribute('data-source', source);
      mermaidPre.textContent = source; // Fallback display before JS runs
      pre.replaceWith(mermaidPre);
      hasMermaid = true;
    }
  });

  // Handle atom mermaid nodes (serialized as <div data-type="mermaid">)
  const mermaidDivs = container.querySelectorAll('div[data-type="mermaid"]');
  mermaidDivs.forEach((div) => {
    const source = (div as HTMLElement).dataset.content || div.textContent || '';
    const mermaidPre = document.createElement('pre');
    mermaidPre.className = 'mermaid';
    mermaidPre.setAttribute('data-source', source);
    mermaidPre.textContent = source;
    div.replaceWith(mermaidPre);
    hasMermaid = true;
  });

  return hasMermaid;
}

/**
 * Render math-inline and math-block elements using KaTeX.
 * Returns true if any math was found.
 */
export function renderMathBlocks(container: HTMLElement): boolean {
  let hasMath = false;

  // Inline math: <math-inline>
  container.querySelectorAll('math-inline').forEach((el) => {
    const tex = el.textContent || '';
    if (!tex.trim()) return;
    try {
      el.innerHTML = katex.renderToString(tex, {
        displayMode: false,
        throwOnError: false,
      });
      hasMath = true;
    } catch (err) {
      console.warn('[InLineMd] KaTeX inline render error:', err);
    }
  });

  // Block math: <math-block>
  container.querySelectorAll('math-block').forEach((el) => {
    const tex = el.textContent || '';
    if (!tex.trim()) return;
    try {
      el.innerHTML = katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
      });
      hasMath = true;
    } catch (err) {
      console.warn('[InLineMd] KaTeX block render error:', err);
    }
  });

  return hasMath;
}

/**
 * Post-process HTML comments: convert generic html-block with <!-- content -->
 * into a compact comment block with icon + label (matching editor appearance).
 */
export function processHtmlComments(container: HTMLElement): void {
  container.querySelectorAll('div.html-block').forEach((el) => {
    const html = el.getAttribute('data-html') || '';
    if (html.trimStart().startsWith('<!--')) {
      const commentText = html.replace(/^\s*<!--\s*/, '').replace(/\s*-->\s*$/, '');

      el.className = 'html-comment';
      el.removeAttribute('data-type');
      el.removeAttribute('data-html');
      el.removeAttribute('contenteditable');
      el.innerHTML = '';

      // Icon (chat bubble SVG, same as editor)
      const icon = document.createElement('span');
      icon.className = 'html-comment-icon';
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      el.appendChild(icon);

      // Label (full text, allow multiline)
      const label = document.createElement('span');
      label.className = 'html-comment-label';
      label.textContent = commentText;
      el.appendChild(label);
    }
  });
}

/**
 * Post-process footnotes: add IDs and anchor links for bidirectional navigation
 * between footnote references [^label] and definitions [^label]:.
 */
export function processFootnotes(container: HTMLElement): void {
  // Footnote references: <sup class="footnote-ref" data-label="...">
  container.querySelectorAll('sup.footnote-ref').forEach((el) => {
    const label = (el as HTMLElement).dataset.label;
    if (!label) return;

    el.id = `fn-ref-${label}`;

    // Wrap text in anchor link to definition
    const link = document.createElement('a');
    link.href = `#fn-def-${label}`;
    link.textContent = el.textContent || '';
    link.style.color = 'inherit';
    link.style.textDecoration = 'inherit';
    el.textContent = '';
    el.appendChild(link);
  });

  // Footnote definitions: <div class="footnote-def" data-label="...">
  container.querySelectorAll('div.footnote-def').forEach((el) => {
    const label = (el as HTMLElement).dataset.label;
    if (!label) return;

    el.id = `fn-def-${label}`;

    // Wrap label text in anchor link back to reference
    const labelEl = el.querySelector('.footnote-label');
    if (labelEl) {
      const link = document.createElement('a');
      link.href = `#fn-ref-${label}`;
      link.textContent = labelEl.textContent || '';
      link.style.color = 'inherit';
      link.style.textDecoration = 'inherit';
      labelEl.textContent = '';
      labelEl.appendChild(link);
    }
  });
}

/**
 * Render inline [[_TOC_]] blocks as actual table of contents with heading links.
 * Replaces the placeholder <div class="toc-block">Table of Contents</div>
 * with a styled block matching the editor's NodeView.
 */
export function renderTocBlocks(container: HTMLElement, toc: TocEntry[]): void {
  container.querySelectorAll('div.toc-block').forEach((el) => {
    const block = document.createElement('div');
    block.className = 'toc-block';

    // Header
    const header = document.createElement('div');
    header.className = 'toc-block-header';
    header.textContent = 'Table of Contents';
    block.appendChild(header);

    // List of heading links
    const list = document.createElement('div');
    list.className = 'toc-block-list';

    if (toc.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'toc-block-empty';
      empty.textContent = 'No headings found';
      list.appendChild(empty);
    } else {
      // Normalize levels (min becomes 1), same as editor
      const minLevel = toc.reduce((min, h) => Math.min(min, h.level), Infinity);
      const adjustment = minLevel - 1;

      for (const entry of toc) {
        const item = document.createElement('div');
        item.className = 'toc-block-item';
        item.setAttribute('data-level', String(entry.level - adjustment));

        const link = document.createElement('a');
        link.className = 'toc-block-link';
        link.href = `#${entry.id}`;
        link.textContent = entry.text;
        item.appendChild(link);
        list.appendChild(item);
      }
    }

    block.appendChild(list);
    el.replaceWith(block);
  });
}

// ─── Table keyword badges ────────────────────────────────────────────────────

const KW_LOWER: Record<string, string> = {
  true: 'green', yes: 'green', да: 'green',
  false: 'red', no: 'red', нет: 'red',
  null: 'gray', 'n/a': 'gray', na: 'gray', none: 'gray',
};
const KW_EXACT: Record<string, string> = { '—': 'gray', '-': 'gray', '--': 'gray' };

function getKwColor(text: string): string | null {
  return KW_EXACT[text] ?? KW_LOWER[text.toLowerCase()] ?? null;
}

/**
 * Wrap standalone keyword text in table cells with badge spans.
 */
export function processTableKeywords(container: HTMLElement): void {
  container.querySelectorAll('td, th').forEach((cell) => {
    const trimmed = (cell.textContent || '').trim();
    const color = getKwColor(trimmed);
    if (!color) return;

    // Only wrap if cell has simple text content (single paragraph or direct text)
    const p = cell.querySelector('p');
    const target = p || cell;
    // Check that the text node is the only meaningful content
    if (target.childNodes.length === 1 && target.firstChild?.nodeType === 3) {
      const text = target.firstChild.textContent || '';
      const span = document.createElement('span');
      span.className = `table-kw table-kw-${color}`;
      span.textContent = text.trim();
      target.textContent = '';
      target.appendChild(span);
    }
  });
}
