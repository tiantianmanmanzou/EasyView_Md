import { describe, test, expect } from 'bun:test';

import { layoutDocument } from '../index';
import type { FlowBlock, Measure } from '../types';

import { makeParagraphBlock, makeLine, makeParagraphMeasure, makeLayoutOptions } from './helpers';

describe('Section Breaks', () => {
  test('nextPage section break forces new page', () => {
    const blocks: FlowBlock[] = [
      makeParagraphBlock(0, 'Before section', 1),
      { kind: 'sectionBreak', id: 1, type: 'nextPage' },
      makeParagraphBlock(2, 'After section', 18),
    ];
    const measures: Measure[] = [
      makeParagraphMeasure([makeLine(0, 0, 0, 14, 120, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 13, 110, 24)]),
    ];

    const layout = layoutDocument(blocks, measures, makeLayoutOptions());

    expect(layout.pages.length).toBe(2);
    expect(layout.pages[0].fragments.some((f) => f.blockId === 0)).toBe(true);
    expect(layout.pages[1].fragments.some((f) => f.blockId === 2)).toBe(true);
  });

  test('continuous section break does not force new page', () => {
    const blocks: FlowBlock[] = [
      makeParagraphBlock(0, 'Before section', 1),
      { kind: 'sectionBreak', id: 1, type: 'continuous' },
      makeParagraphBlock(2, 'After section', 18),
    ];
    const measures: Measure[] = [
      makeParagraphMeasure([makeLine(0, 0, 0, 14, 120, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 13, 110, 24)]),
    ];

    const layout = layoutDocument(blocks, measures, { ...makeLayoutOptions(), bodyBreakType: 'continuous' });

    expect(layout.pages.length).toBe(1);
    expect(layout.pages[0].fragments.length).toBe(2);
  });

  test('explicit continuous on the next section stays on the page even if this break is nextPage', () => {
    const blocks: FlowBlock[] = [
      makeParagraphBlock(0, 'Before section', 1),
      { kind: 'sectionBreak', id: 1, type: 'nextPage' },
      makeParagraphBlock(2, 'After section', 18),
    ];
    const measures: Measure[] = [
      makeParagraphMeasure([makeLine(0, 0, 0, 14, 120, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 13, 110, 24)]),
    ];

    const layout = layoutDocument(blocks, measures, { ...makeLayoutOptions(), bodyBreakType: 'continuous' });

    expect(layout.pages.length).toBe(1);
    expect(layout.pages[0].fragments.some((f) => f.blockId === 2)).toBe(true);
  });

  test('omitted next section type starts on a new page instead of inheriting continuous', () => {
    const blocks: FlowBlock[] = [
      makeParagraphBlock(0, 'Cover', 1),
      { kind: 'sectionBreak', id: 1, type: 'continuous' },
      makeParagraphBlock(2, 'TOC', 8),
      { kind: 'sectionBreak', id: 3 },
      makeParagraphBlock(4, 'Body', 20),
    ];
    const measures: Measure[] = [
      makeParagraphMeasure([makeLine(0, 0, 0, 5, 80, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 3, 80, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 4, 80, 24)]),
    ];

    const layout = layoutDocument(blocks, measures, makeLayoutOptions());

    expect(layout.pages.map((page) => page.fragments.some((f) => f.blockId === 0))).toEqual([true, false, false]);
    expect(layout.pages.map((page) => page.fragments.some((f) => f.blockId === 2))).toEqual([false, true, false]);
    expect(layout.pages.map((page) => page.fragments.some((f) => f.blockId === 4))).toEqual([false, false, true]);
  });

  test('evenPage starts the next section on an even page, inserting a blank page when needed', () => {
    const blocks: FlowBlock[] = [
      makeParagraphBlock(0, 'Page one', 1),
      { kind: 'sectionBreak', id: 1, type: 'nextPage' },
      makeParagraphBlock(2, 'Page two', 8),
      { kind: 'sectionBreak', id: 3, type: 'nextPage' },
      makeParagraphBlock(4, 'Even section', 20),
    ];
    const measures: Measure[] = [
      makeParagraphMeasure([makeLine(0, 0, 0, 8, 80, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 8, 80, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 12, 80, 24)]),
    ];

    const layout = layoutDocument(blocks, measures, { ...makeLayoutOptions(), bodyBreakType: 'evenPage' });

    expect(layout.pages).toHaveLength(4);
    expect(layout.pages[3].number % 2).toBe(0);
    expect(layout.pages[3].fragments.some((f) => f.blockId === 4)).toBe(true);
    expect(layout.pages[2].fragments.some((f) => f.blockId === 4)).toBe(false);
  });

  test('oddPage starts the next section on an odd page, inserting a blank page when needed', () => {
    const blocks: FlowBlock[] = [
      makeParagraphBlock(0, 'Cover', 1),
      { kind: 'sectionBreak', id: 1, type: 'continuous' },
      makeParagraphBlock(2, 'Odd section', 8),
    ];
    const measures: Measure[] = [
      makeParagraphMeasure([makeLine(0, 0, 0, 5, 80, 24)]),
      { kind: 'sectionBreak' },
      makeParagraphMeasure([makeLine(0, 0, 0, 11, 80, 24)]),
    ];

    const layout = layoutDocument(blocks, measures, { ...makeLayoutOptions(), bodyBreakType: 'oddPage' });

    expect(layout.pages).toHaveLength(3);
    expect(layout.pages[2].number % 2).toBe(1);
    expect(layout.pages[2].fragments.some((f) => f.blockId === 2)).toBe(true);
    expect(layout.pages[1].fragments).toHaveLength(0);
  });
});
