/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../../editor/EditorSchema';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import { BlockEdgeCursor } from '../../behavior/block-edge-cursor/BlockEdgeCursor';
import { tryPlaceBlockEdgeAfterNestedTableFromClick } from '../../behavior/block-edge-cursor/BlockEdgeCursorExtension';
import { handleNestedTableEnter } from './nestedTableEnter';

function createView(markdown: string): EditorView {
  const doc = parseMarkdown(markdown, createParser());
  const state = EditorState.create({ doc: doc! });
  const view = new EditorView(document.createElement('div'), { state });
  return view;
}

function findNestedTableInHostCell(doc: NonNullable<ReturnType<typeof parseMarkdown>>) {
  let nestedTablePos = -1;
  let textPos = -1;
  doc.descendants((node, pos, parent) => {
    if (nestedTablePos >= 0) return false;
    if (
      node.type.name === 'table' &&
      (parent?.type.name === 'table_cell' || parent?.type.name === 'table_header')
    ) {
      nestedTablePos = pos;
      node.descendants((child, childPos) => {
        if (child.isText && child.text === 'tail text') {
          textPos = pos + childPos + 1 + child.text.length;
        }
        return true;
      });
      return false;
    }
    return true;
  });
  expect(nestedTablePos).toBeGreaterThan(0);
  expect(textPos).toBeGreaterThan(0);
  return { nestedTablePos, textPos };
}

describe('nested table Enter handling', () => {
  it('inserts a paragraph below a nested table from the nested table bottom exit', () => {
    const markdown = `<table>
<tr><td>outer</td><td>
intro
<table>
<tr><th>A</th><th>B</th></tr>
<tr><td>one</td><td>tail text</td></tr>
</table>
</td></tr>
</table>`;

    const view = createView(markdown);
    const { textPos } = findNestedTableInHostCell(view.state.doc);

    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos)),
    );

    expect(handleNestedTableEnter(view)).toBe(true);

    const hostCell = view.state.doc.child(0).child(0).child(1);
    expect(hostCell.childCount).toBeGreaterThan(2);
    expect(hostCell.child(2).type.name).toBe('paragraph');
    expect(hostCell.child(2).textContent).toBe('');
    view.destroy();
  });

  it('focuses an existing empty paragraph below a nested table from BlockEdgeCursor', () => {
    const markdown = `<table>
<tr><td>outer</td><td>
<table>
<tr><td>one</td></tr>
</table>

</td></tr>
</table>`;

    const view = createView(markdown);
    let gapPos = -1;
    view.state.doc.descendants((node, pos, parent) => {
      if (gapPos >= 0) return false;
      if (
        node.type.name === 'table' &&
        (parent?.type.name === 'table_cell' || parent?.type.name === 'table_header')
      ) {
        gapPos = pos + node.nodeSize;
        return false;
      }
      return true;
    });
    expect(gapPos).toBeGreaterThan(0);

    view.dispatch(
      view.state.tr.setSelection(new BlockEdgeCursor(view.state.doc.resolve(gapPos))),
    );

    expect(handleNestedTableEnter(view)).toBe(true);
    expect(view.state.selection.from).toBeGreaterThan(gapPos);
    view.destroy();
  });

  it('places BlockEdgeCursor when clicking the gap to the right of a nested table', () => {
    const markdown = `<table>
<tr><td>outer</td><td>
<table>
<tr><td>one</td></tr>
</table>
</td></tr>
</table>`;

    const view = createView(markdown);
    const nestedWrapper = view.dom.querySelector('td .table-wrapper') as HTMLElement;
    expect(nestedWrapper).toBeTruthy();
    const hostCell = nestedWrapper.closest('td, th') as HTMLElement;
    expect(hostCell).toBeTruthy();

    nestedWrapper.getBoundingClientRect = () => new DOMRect(10, 20, 180, 80);
    hostCell.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);

    const handled = tryPlaceBlockEdgeAfterNestedTableFromClick(view, {
      clientX: 220,
      clientY: 40,
      target: hostCell,
    } as MouseEvent);

    expect(handled).toBe(true);
    expect(view.state.selection).toBeInstanceOf(BlockEdgeCursor);
    view.destroy();
  });
});
