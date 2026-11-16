const HTTP_URL = /https?:\/\/[^\s<>"'`)\]]+/gi;

function trimUrl(value: string): string {
  return value.replace(/[.,;:!?)]+$/g, '');
}

/** A URL covering `offset`, or the only URL in the text when the click has no offset. */
export function urlInText(text: string, offset: number | null): string | null {
  const matches = [...text.matchAll(HTTP_URL)].map((match) => {
    const raw = match[0];
    const url = trimUrl(raw);
    const start = match.index ?? 0;
    return { url, start, end: start + raw.length };
  });
  if (offset !== null) {
    const hit = matches.find((match) => offset >= match.start && offset <= match.end);
    if (hit) return hit.url;
  }
  return matches.length === 1 ? matches[0].url : null;
}

function offsetOf(root: Element, target: Node): number | null {
  if (target === root) return null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === target || (target instanceof Element && target.contains(node))) return offset;
    offset += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  return null;
}

/** http(s) link under a Markdown anchor or a code/source line. Other schemes are ignored. */
export function browserLinkFromEvent(event: { target: EventTarget | null }): string | null {
  const element = event.target instanceof Element ? event.target : null;
  if (!element) return null;
  const anchor = element.closest('a[href]');
  const href = anchor?.getAttribute('href')?.trim() ?? '';
  if (/^https?:\/\//i.test(href)) return trimUrl(href);
  const line = element.closest('.cm-line, pre, code');
  if (!line) return null;
  return urlInText(line.textContent ?? '', offsetOf(line, element));
}
