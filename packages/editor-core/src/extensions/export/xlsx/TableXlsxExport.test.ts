/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import { buildTableXlsxPayload } from './TableXlsxExport';
import { toggleDuplicateCellMerges } from '../../blocks/table/TableCommands';

function viewFor(markdown: string): EditorView {
  const doc = parseMarkdown(markdown, createParser())!;
  const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc }) });
  let pos = -1;
  view.state.doc.descendants((node, offset) => {
    if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
      pos = offset + 1;
      return false;
    }
    return true;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
  return view;
}

describe('buildTableXlsxPayload', () => {
  it('lays out a flat table with no merges', () => {
    const view = viewFor(`<table>
<tr><th>名称</th><th>值</th></tr>
<tr><td>A</td><td>1</td></tr>
</table>`);
    const payload = buildTableXlsxPayload(view.state);
    expect(payload.totalRows).toBe(2);
    expect(payload.totalCols).toBe(2);
    expect(payload.merges).toEqual([]);
    expect(payload.cells).toHaveLength(4);
    expect(payload.cells.find((c) => c.row === 0 && c.col === 0)).toMatchObject({
      text: '名称',
      isHeader: true,
      rowspan: 1,
      colspan: 1,
    });
    expect(payload.cells.find((c) => c.row === 1 && c.col === 1)).toMatchObject({
      text: '1',
      isHeader: false,
    });
  });

  it('preserves rowspan merges from HTML tables', () => {
    const view = viewFor(`<table>
<tr><td rowspan="2">一级</td><td rowspan="2">一级描述</td><td>三级A</td></tr>
<tr><td>三级B</td></tr>
</table>`);
    const payload = buildTableXlsxPayload(view.state);
    expect(payload.totalRows).toBe(2);
    expect(payload.totalCols).toBe(3);
    expect(payload.merges).toContainEqual({ top: 0, left: 0, bottom: 1, right: 0 });
    expect(payload.merges).toContainEqual({ top: 0, left: 1, bottom: 1, right: 1 });
    const merged = payload.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(merged).toMatchObject({ text: '一级', rowspan: 2, colspan: 1 });
    const bottom = payload.cells.find((c) => c.row === 1 && c.col === 2)!;
    expect(bottom).toMatchObject({ text: '三级B', rowspan: 1, colspan: 1 });
  });

  it('does not emit merges for a table without spanned cells', () => {
    const view = viewFor(`<table>
<tr><td>A</td><td>B</td></tr>
<tr><td>C</td><td>D</td></tr>
</table>`);
    const payload = buildTableXlsxPayload(view.state);
    expect(payload.merges).toEqual([]);
    expect(payload.cells.every((c) => c.rowspan === 1 && c.colspan === 1)).toBe(true);
  });
});

describe('buildTableXlsxPayload after duplicate-cell merge toggle', () => {
  it('reflects the merge state produced by the auto-merge button', () => {
    const view = viewFor(`<table>
<tr><td>A</td><td>一</td></tr>
<tr><td>A</td><td>二</td></tr>
</table>`);
    toggleDuplicateCellMerges()(view.state, view.dispatch);
    const payload = buildTableXlsxPayload(view.state);
    expect(payload.totalRows).toBe(2);
    expect(payload.totalCols).toBe(2);
    // Column 0 becomes a vertical merge (A spans both rows).
    expect(payload.merges).toContainEqual({ top: 0, left: 0, bottom: 1, right: 0 });
    const origin = payload.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(origin).toMatchObject({ text: 'A', rowspan: 2, colspan: 1 });

    // Toggling again removes the merge.
    toggleDuplicateCellMerges()(view.state, view.dispatch);
    const payloadAfter = buildTableXlsxPayload(view.state);
    expect(payloadAfter.merges).toEqual([]);
  });
});
