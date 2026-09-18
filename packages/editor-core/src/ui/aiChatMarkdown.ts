/**
 * Markdown rendering for AI chat messages plus extraction of the fenced
 * document block emitted by the model in agent mode.
 */

import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 48) || 'h';
}

/** Renders assistant markdown into sanitized HTML (raw HTML disabled). */
export function renderAssistantMarkdown(text: string): string {
  return markdown.render(text);
}

/** Adds a heading id so in-panel anchor links work. Called post-render. */
export function decorateRenderedMarkdown(container: HTMLElement, onCopyCode: (code: string) => void): void {
  for (const heading of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    heading.id = `ai-chat-${slugify(heading.textContent ?? '')}`;
  }
  for (const block of container.querySelectorAll('pre > code')) {
    const pre = block.parentElement as HTMLPreElement;
    if (pre.querySelector('.ai-chat-code-copy')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-chat-code-copy';
    button.textContent = '复制';
    button.addEventListener('click', () => {
      onCopyCode(block.textContent ?? '');
      button.textContent = '已复制';
      window.setTimeout(() => {
        button.textContent = '复制';
      }, 1500);
    });
    pre.appendChild(button);
  }
}

export interface ExtractedMarkdownBlock {
  content: string;
}

/**
 * Extracts the document block from an agent-mode reply: the LAST fenced code
 * block whose info string starts with `markdown` (3+ backticks; tolerates an
 * unterminated final fence and four-backtick outer fences).
 */
export function extractMarkdownBlock(text: string): ExtractedMarkdownBlock | null {
  const fenceRegex = /(^|\n)(`{3,})([^\n`]*)\n?([\s\S]*?)(?=\n\2\n?|$)/g;
  let match: RegExpExecArray | null;
  let last: { content: string } | null = null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const info = (match[3] ?? '').trim().toLowerCase();
    const content = match[4] ?? '';
    if (info === 'markdown' || info === 'md') {
      last = { content: content.replace(/\n$/, '') };
    }
  }
  if (last) return last;

  // Fallback: a single unterminated ```markdown fence opened at the end.
  const openFence = text.match(/(^|\n)(`{3,})(markdown|md)[^\n]*\n([\s\S]+)$/i);
  if (openFence) {
    return { content: openFence[4].replace(/\n$/, '') };
  }
  return null;
}
