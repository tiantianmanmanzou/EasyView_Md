import { test, expect } from 'bun:test';
import { layoutDocument } from '../index';
import { makeParagraphBlock, makeLine, makeParagraphMeasure, makeLayoutOptions } from './helpers';

test('a missing next section type defaults to a new page', () => {
  const blocks = [makeParagraphBlock(0, 'cover', 1), { kind: 'sectionBreak' as const, id: 1, type: 'continuous' as const }, makeParagraphBlock(2, 'toc', 8)];
  const measures = [makeParagraphMeasure([makeLine(0, 0, 0, 5, 100, 24)]), { kind: 'sectionBreak' as const }, makeParagraphMeasure([makeLine(0, 0, 0, 3, 100, 24)])];
  const layout = layoutDocument(blocks, measures, makeLayoutOptions());
  expect(layout.pages.length).toBe(2);
});
