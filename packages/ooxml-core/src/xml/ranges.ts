/**
 * Lightweight XML element range indexing over UTF-8 bytes.
 * Records start/end byte offsets for each element open…close span.
 */

export interface XmlElementRange {
  /** Local name without prefix. */
  name: string;
  /** Qualified name as written in the file. */
  qName: string;
  /** Inclusive start byte offset of the opening `<`. */
  start: number;
  /** Exclusive end byte offset after the closing `>` of the end-tag (or self-close). */
  end: number;
  /** Depth in the element stack (root = 0). */
  depth: number;
  children: XmlElementRange[];
}

export interface XmlRangeIndex {
  root: XmlElementRange[];
  /** Flat list in document order. */
  all: XmlElementRange[];
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/** Build an element range tree. Throws on truncated / mismatched tags. */
export function indexXmlElementRanges(bytes: Uint8Array): XmlRangeIndex {
  const text = decoder.decode(bytes);
  const byteAt = buildByteOffsetMap(text);

  const root: XmlElementRange[] = [];
  const stack: XmlElementRange[] = [];
  const all: XmlElementRange[] = [];
  let i = 0;

  while (i < text.length) {
    if (text.charCodeAt(i) !== 60 /* < */) {
      i += 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('</', i)) {
      const close = text.indexOf('>', i + 2);
      if (close < 0) throw new Error('Unclosed end tag');
      const qName = text.slice(i + 2, close).trim();
      const name = localName(qName);
      const node = stack.pop();
      if (!node || node.name !== name) {
        throw new Error(`Mismatched end tag </${qName}>, expected </${node?.qName ?? '?'}>`);
      }
      node.end = byteAt[close + 1] ?? bytes.length;
      i = close + 1;
      continue;
    }

    const start = i;
    let j = i + 1;
    while (j < text.length && !isNameEnd(text.charCodeAt(j))) j += 1;
    const qName = text.slice(i + 1, j);
    const name = localName(qName);
    const gt = text.indexOf('>', j);
    if (gt < 0) throw new Error(`Unclosed start tag <${qName}`);
    const selfClosing = text[gt - 1] === '/';

    const node: XmlElementRange = {
      name,
      qName,
      start: byteAt[start] ?? 0,
      end: byteAt[gt + 1] ?? bytes.length,
      depth: stack.length,
      children: [],
    };
    all.push(node);
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root.push(node);

    i = gt + 1;
    if (!selfClosing) stack.push(node);
  }

  if (stack.length) throw new Error(`Unclosed element <${stack[stack.length - 1].qName}>`);
  return { root, all };
}

export function findElementsByName(index: XmlRangeIndex, name: string): XmlElementRange[] {
  return index.all.filter((el) => el.name === name);
}

function localName(qName: string): string {
  const idx = qName.indexOf(':');
  return idx >= 0 ? qName.slice(idx + 1) : qName;
}

function isNameEnd(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 47 || code === 62;
}

/** byteAt[stringIndex] = utf8 byte offset; length = text.length + 1. */
function buildByteOffsetMap(text: string): number[] {
  const map = new Array<number>(text.length + 1);
  let byte = 0;
  for (let i = 0; i < text.length; i += 1) {
    map[i] = byte;
    const code = text.charCodeAt(i);
    if (code <= 0x7f) byte += 1;
    else if (code <= 0x7ff) byte += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Lead surrogate: encode the pair as one code point (4 bytes).
      byte += 4;
      map[i + 1] = byte; // trail surrogate shares the code point end; next loop bumps i
      i += 1;
      if (i < text.length) map[i] = byte;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      byte += encoder.encode(text[i]).length;
    } else byte += 3;
  }
  map[text.length] = byte;
  return map;
}
