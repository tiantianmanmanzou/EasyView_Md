import { describe, expect, it } from 'vitest';
import { applyPreciseUpdates, replaceFirstElementByName } from './engine';
import { indexXmlElementRanges } from './ranges';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

describe('XML precise updates', () => {
  it('indexes element byte ranges', () => {
    const xml = '<?xml version="1.0"?><root><a>1</a><b/></root>';
    const bytes = encoder.encode(xml);
    const index = indexXmlElementRanges(bytes);
    expect(index.all.map((el) => el.name)).toEqual(['root', 'a', 'b']);
    const a = index.all.find((el) => el.name === 'a')!;
    expect(decoder.decode(bytes.subarray(a.start, a.end))).toBe('<a>1</a>');
  });

  it('replaces a single node and leaves neighbors intact', () => {
    const xml = '<root><keep>x</keep><target>old</target><keep>y</keep></root>';
    const out = replaceFirstElementByName(encoder.encode(xml), 'target', '<target>new</target>');
    expect(decoder.decode(out)).toBe('<root><keep>x</keep><target>new</target><keep>y</keep></root>');
  });

  it('rejects overlapping ranges in one apply', () => {
    const xml = '<root><a><b>1</b></a></root>';
    const bytes = encoder.encode(xml);
    const index = indexXmlElementRanges(bytes);
    const a = index.all.find((el) => el.name === 'a')!;
    const b = index.all.find((el) => el.name === 'b')!;
    expect(() =>
      applyPreciseUpdates(bytes, [
        { change: { type: 'deleteNode', range: a } },
        { change: { type: 'deleteNode', range: b } },
      ]),
    ).toThrow(/Overlap/i);
  });

  it('applies multiple non-overlapping updates in one call', () => {
    const xml = '<root><a>1</a><b>2</b><c>3</c></root>';
    const bytes = encoder.encode(xml);
    const index = indexXmlElementRanges(bytes);
    const a = index.all.find((el) => el.name === 'a')!;
    const c = index.all.find((el) => el.name === 'c')!;
    const out = applyPreciseUpdates(bytes, [
      { change: { type: 'replaceNode', range: a, bytes: encoder.encode('<a>A</a>') } },
      { change: { type: 'replaceNode', range: c, bytes: encoder.encode('<c>C</c>') } },
    ]);
    expect(decoder.decode(out)).toBe('<root><a>A</a><b>2</b><c>C</c></root>');
  });
});
