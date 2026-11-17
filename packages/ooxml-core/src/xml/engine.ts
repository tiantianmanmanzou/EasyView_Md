import type { XmlElementRange } from './ranges';
import { indexXmlElementRanges } from './ranges';

export type XmlChange =
  | { type: 'replaceNode'; range: XmlElementRange; bytes: Uint8Array }
  | { type: 'deleteNode'; range: XmlElementRange }
  | { type: 'insertAfter'; range: XmlElementRange; bytes: Uint8Array }
  | { type: 'insertBefore'; range: XmlElementRange; bytes: Uint8Array };

export interface PreciseUpdate {
  /** Opaque locator retained for callers / logging. */
  target?: unknown;
  change: XmlChange;
}

/**
 * Apply one or many precise updates to an XML part.
 * Single entry path: length-1 and multi-target use the same merge/splice logic.
 */
export function applyPreciseUpdates(original: Uint8Array, updates: PreciseUpdate[]): Uint8Array {
  if (updates.length === 0) return original;

  const spans = updates.map((update, index) => {
    const { change } = update;
    const range = change.range;
    if (change.type === 'replaceNode' || change.type === 'deleteNode') {
      return {
        index,
        start: range.start,
        end: range.end,
        insert: change.type === 'replaceNode' ? change.bytes : new Uint8Array(),
      };
    }
    if (change.type === 'insertAfter') {
      return { index, start: range.end, end: range.end, insert: change.bytes };
    }
    return { index, start: range.start, end: range.start, insert: change.bytes };
  });

  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);

  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) {
      throw new Error(
        `Overlapping XML update ranges at ${spans[i - 1].start}-${spans[i - 1].end} and ${spans[i].start}-${spans[i].end}`,
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) throw new Error('Internal update ordering error');
    if (span.start > cursor) chunks.push(original.subarray(cursor, span.start));
    if (span.insert.length) chunks.push(span.insert);
    cursor = span.end;
  }
  if (cursor < original.length) chunks.push(original.subarray(cursor));

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Convenience: replace the first element with local name `name`. */
export function replaceFirstElementByName(
  original: Uint8Array,
  name: string,
  replacementXml: string,
): Uint8Array {
  const index = indexXmlElementRanges(original);
  const hit = index.all.find((el) => el.name === name);
  if (!hit) throw new Error(`Element <${name}> not found`);
  return applyPreciseUpdates(original, [
    {
      change: {
        type: 'replaceNode',
        range: hit,
        bytes: new TextEncoder().encode(replacementXml),
      },
    },
  ]);
}
