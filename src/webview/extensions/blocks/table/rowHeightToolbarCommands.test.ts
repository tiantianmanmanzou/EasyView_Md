/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import { adjustAllRowHeights, getRepresentativeRowHeight, setAllRowHeights } from './TableCommands';

function createView(): EditorView {
  const doc = parseMarkdown(`<table>
<tr><td>A</td><td>B</td></tr>
<tr><td>C</td><td>D</td></tr>
<tr><td>E</td><td>F</td></tr>
</table>`, createParser())!;
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc }) });
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(3))));
  return view;
}

function heights(view: EditorView): Array<number | null> {
  const table = view.state.doc.firstChild!;
  return Array.from({ length: table.childCount }, (_, index) => table.child(index).attrs.height);
}

describe('all-row height commands', () => {
  it('sets and adjusts every row in the current table', () => {
    const view = createView();
    expect(getRepresentativeRowHeight(view.state, 48)).toBe(48);
    expect(setAllRowHeights({ height: 96 })(view.state, view.dispatch)).toBe(true);
    expect(heights(view)).toEqual([96, 96, 96]);
    expect(getRepresentativeRowHeight(view.state, 48)).toBe(96);
    expect(adjustAllRowHeights({ delta: -12 })(view.state, view.dispatch)).toBe(true);
    expect(heights(view)).toEqual([84, 84, 84]);
  });

  it('clamps all row heights to the supported range', () => {
    const view = createView();
    setAllRowHeights({ height: 1 })(view.state, view.dispatch);
    expect(heights(view)).toEqual([36, 36, 36]);
    setAllRowHeights({ height: 9999 })(view.state, view.dispatch);
    expect(heights(view)).toEqual([1200, 1200, 1200]);
  });
});
