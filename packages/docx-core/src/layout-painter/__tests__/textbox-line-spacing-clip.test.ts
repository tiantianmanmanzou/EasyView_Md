/** @vitest-environment happy-dom */
/** @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}} */
/**
 * Cover titles often live in a short fixed text box (a:noAutofit) while the
 * paragraph keeps a large auto line-spacing multiplier. Without clamping /
 * top-aligning, CSS half-leading centers the glyphs in the tall line box and
 * overflow:hidden slices through the characters.
 */

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { clampTextBoxMeasures, renderTextBoxFragment } from '../renderTextBox';
import type {
  TextBoxBlock,
  TextBoxFragment,
  TextBoxMeasure,
  ParagraphBlock,
  ParagraphMeasure,
} from '../../layout-engine/types';

function createDocument(): Document {
  return new Window().document as unknown as Document;
}

const paragraph: ParagraphBlock = {
  kind: 'paragraph',
  id: 'title',
  runs: [
    {
      kind: 'text',
      text: '中国移动通信企业标准',
      fontSize: 36,
      bold: true,
      pmStart: 0,
      pmEnd: 10,
    },
  ],
  attrs: {
    alignment: 'center',
    spacing: { line: 3, lineUnit: 'multiplier', lineRule: 'auto' },
  },
  pmStart: 0,
  pmEnd: 11,
};

const tallMeasure: ParagraphMeasure = {
  kind: 'paragraph',
  lines: [
    {
      fromRun: 0,
      fromChar: 0,
      toRun: 0,
      toChar: 10,
      width: 400,
      ascent: 38.4,
      descent: 9.6,
      lineHeight: 150,
    },
  ],
  totalHeight: 150,
};

describe('fixed text box with oversized auto line spacing', () => {
  test('clamps the line box down to the text box height so glyphs can fit', () => {
    const measure: TextBoxMeasure = {
      kind: 'textBox',
      width: 594,
      height: 71.4,
      innerMeasures: [tallMeasure],
    };
    const clamped = clampTextBoxMeasures(measure, 71.4);
    const line = (clamped.innerMeasures[0] as ParagraphMeasure).lines[0];
    expect(line.lineHeight).toBeCloseTo(71.4, 5);
    expect(line.lineHeight).toBeGreaterThanOrEqual(line.ascent + line.descent);
    expect(clamped.innerMeasures[0].totalHeight).toBeCloseTo(71.4, 5);
  });

  test('paints the title line no taller than the text box and top-aligns glyphs', () => {
    const block: TextBoxBlock = {
      kind: 'textBox',
      id: 'cover-title',
      width: 594,
      height: 71.4,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      verticalAlign: 'top',
      content: [paragraph],
    };
    const fragment: TextBoxFragment = {
      kind: 'textBox',
      blockId: block.id,
      x: 0,
      y: 0,
      width: 594,
      height: 71.4,
    };
    const measure: TextBoxMeasure = {
      kind: 'textBox',
      width: 594,
      height: 71.4,
      innerMeasures: [tallMeasure],
    };

    const el = renderTextBoxFragment(
      fragment,
      block,
      measure,
      { pageNumber: 1, totalPages: 1, section: 'body' },
      { document: createDocument() }
    );

    expect(el.style.overflow).toBe('hidden');
    expect(el.style.height).toBe('71.4px');
    const line = el.querySelector('.layout-line') as HTMLElement | null;
    expect(line).not.toBeNull();
    expect(Number.parseFloat(line!.style.height)).toBeLessThanOrEqual(71.4 + 0.01);
    expect(line!.style.alignItems).toBe('flex-start');
    expect(el.textContent).toContain('中国移动通信企业标准');
  });
});
