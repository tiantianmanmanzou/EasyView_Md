function getHtmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function hasMarkClass(attrs: string): boolean {
  const className = getHtmlAttribute(`<span${attrs}>`, 'class') ?? '';
  return className.split(/\s+/).includes('mark');
}

export function isPandocHighlightOpenTag(html: string): boolean {
  const trimmed = html.trim();
  const match = trimmed.match(/^<(span|mark)\b([^>]*)>$/i);
  if (!match) return false;
  return match[1].toLowerCase() === 'mark' || hasMarkClass(match[2] ?? '');
}

export function isPandocHighlightCloseTag(html: string, tagName?: string): boolean {
  const trimmed = html.trim();
  const match = trimmed.match(/^<\/(span|mark)\s*>$/i);
  if (!match) return false;
  return tagName ? match[1].toLowerCase() === tagName.toLowerCase() : true;
}

function findMatchingClose(
  input: string,
  from: number,
  tagName: string,
): { index: number; length: number } | null {
  const re = new RegExp(`<(/)?${tagName}\\b([^>]*)>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    if (match[1]) {
      depth -= 1;
      if (depth === 0) {
        return { index: match.index, length: match[0].length };
      }
      continue;
    }
    if (!/\/\s*$/.test(match[2] ?? '')) {
      depth += 1;
    }
  }
  return null;
}

function unwrapFirstHighlight(input: string): string {
  const openRe = /<(span|mark)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(input))) {
    const tagName = match[1];
    const attrs = match[2] ?? '';
    if (tagName.toLowerCase() !== 'mark' && !hasMarkClass(attrs)) continue;

    const innerStart = match.index + match[0].length;
    const close = findMatchingClose(input, innerStart, tagName);
    if (!close) continue;

    const inner = input.slice(innerStart, close.index).replace(/^\s+|\s+$/g, '');
    return input.slice(0, match.index) + inner + input.slice(close.index + close.length);
  }
  return input;
}

/**
 * Word highlighter formatting becomes Pandoc `<span class="mark">` / `<mark>`.
 * EasyView treats leftover tags as visible HTML nodes inside headings.
 */
export function stripPandocHighlightMarkup(markdown: string): string {
  let result = markdown;
  for (let i = 0; i < 1000; i++) {
    const next = unwrapFirstHighlight(result);
    if (next === result) break;
    result = next;
  }
  return result;
}
