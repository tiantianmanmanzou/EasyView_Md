/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import { docToMarkdown } from '../../../editor/lib/MarkdownSerializer';
import { hasDuplicateMergedCells, hasRestorableMergeGroups, hasTableCellMerges, supportsDuplicateCellMerges, toggleDuplicateCellMerges } from './TableCommands';

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

function tableRows(view: EditorView) {
  const table = view.state.doc.firstChild!;
  return Array.from({ length: table.childCount }, (_, row) =>
    Array.from({ length: table.child(row).childCount }, (_, col) => {
      const cell = table.child(row).child(col);
      return { text: cell.textContent, rowspan: cell.attrs.rowspan, duplicateMerged: cell.attrs.duplicateMerged };
    }),
  );
}

describe('toggleDuplicateCellMerges', () => {
  it('merges consecutive equal values by column and restores them on the next click', () => {
    const view = viewFor(`<table>
<tr><td>A</td><td>一</td></tr>
<tr><td>A</td><td>二</td></tr>
<tr><td>B</td><td>三</td></tr>
<tr><td>B</td><td>四</td></tr>
</table>`);

    expect(toggleDuplicateCellMerges()(view.state, view.dispatch)).toBe(true);
    expect(hasDuplicateMergedCells(view.state)).toBe(true);
    expect(tableRows(view)).toEqual([
      [{ text: 'A', rowspan: 2, duplicateMerged: true }, { text: '一', rowspan: 1, duplicateMerged: false }],
      [{ text: '二', rowspan: 1, duplicateMerged: false }],
      [{ text: 'B', rowspan: 2, duplicateMerged: true }, { text: '三', rowspan: 1, duplicateMerged: false }],
      [{ text: '四', rowspan: 1, duplicateMerged: false }],
    ]);

    expect(toggleDuplicateCellMerges()(view.state, view.dispatch)).toBe(true);
    expect(hasDuplicateMergedCells(view.state)).toBe(false);
    expect(tableRows(view)).toEqual([
      [{ text: 'A', rowspan: 1, duplicateMerged: false }, { text: '一', rowspan: 1, duplicateMerged: false }],
      [{ text: 'A', rowspan: 1, duplicateMerged: false }, { text: '二', rowspan: 1, duplicateMerged: false }],
      [{ text: 'B', rowspan: 1, duplicateMerged: false }, { text: '三', rowspan: 1, duplicateMerged: false }],
      [{ text: 'B', rowspan: 1, duplicateMerged: false }, { text: '四', rowspan: 1, duplicateMerged: false }],
    ]);
  });

  it('reports existing rowspans as selected and splits them on click', () => {
    const view = viewFor(`<table>
<tr><td rowspan="2">保留</td><td>一</td></tr>
<tr><td>二</td></tr>
</table>`);
    expect(hasTableCellMerges(view.state)).toBe(true);
    expect(supportsDuplicateCellMerges(view.state)).toBe(true);
    expect(toggleDuplicateCellMerges()(view.state, view.dispatch)).toBe(true);
    expect(hasTableCellMerges(view.state)).toBe(false);
    expect(hasRestorableMergeGroups(view.state)).toBe(true);
    expect(tableRows(view)).toEqual([
      [{ text: '保留', rowspan: 1, duplicateMerged: false }, { text: '一', rowspan: 1, duplicateMerged: false }],
      [{ text: '保留', rowspan: 1, duplicateMerged: false }, { text: '二', rowspan: 1, duplicateMerged: false }],
    ]);

    // Second click restores the exact original merge instead of re-analysing
    // the table (important for cells containing nested tables).
    expect(toggleDuplicateCellMerges()(view.state, view.dispatch)).toBe(true);
    expect(hasTableCellMerges(view.state)).toBe(true);
    expect(hasRestorableMergeGroups(view.state)).toBe(false);
    expect(tableRows(view)[0][0]).toMatchObject({ text: '保留', rowspan: 2 });
    expect(tableRows(view)[1]).toHaveLength(1);
  });

  it('merges plain columns even when the table also has nested tables', () => {
    const view = viewFor(`<table>
<tr><th>一级</th><th>描述</th></tr>
<tr><td>A</td><td>
<p>leading</p>
<table border="1">
<tr><th>状态大类</th><th>状态小类</th></tr>
<tr><td>库状态</td><td>库</td></tr>
</table>
<p>trailing</p>
</td></tr>
<tr><td>A</td><td>普通</td></tr>
</table>`);
    expect(supportsDuplicateCellMerges(view.state)).toBe(true);
    expect(toggleDuplicateCellMerges()(view.state, view.dispatch)).toBe(true);
    expect(hasTableCellMerges(view.state)).toBe(true);
    expect(tableRows(view)[1][0]).toMatchObject({ text: 'A', rowspan: 2, duplicateMerged: true });
  });

  it('skips cells that contain nested tables when computing duplicate merges', () => {
    const view = viewFor(`<table>
<tr><td>
<table>
<tr><td>X</td></tr>
<tr><td>X</td></tr>
</table>
</td><td>一</td></tr>
<tr><td>Y</td><td>二</td></tr>
</table>`);
    expect(toggleDuplicateCellMerges()(view.state, view.dispatch)).toBe(true);
    // Nested-table cell is not auto-merged; second column stays unmerged.
    expect(hasTableCellMerges(view.state)).toBe(false);
  });

  it('keeps reversible merge groups through save and reopen', () => {
    const view = viewFor(`<table>
<tr><td rowspan="2" data-easyview-auto-merged="true">保留</td><td>一</td></tr>
<tr><td>二</td></tr>
</table>`);
    toggleDuplicateCellMerges()(view.state, view.dispatch);
    expect(hasRestorableMergeGroups(view.state)).toBe(true);
    const markdown = docToMarkdown(view.state.doc);
    expect(markdown).toContain('data-easyview-merge-group="evm:');

    const reopened = viewFor(markdown);
    expect(hasTableCellMerges(reopened.state)).toBe(false);
    expect(hasRestorableMergeGroups(reopened.state)).toBe(true);
    expect(toggleDuplicateCellMerges()(reopened.state, reopened.dispatch)).toBe(true);
    expect(hasTableCellMerges(reopened.state)).toBe(true);
    expect(tableRows(reopened)[0][0]).toMatchObject({ text: '保留', rowspan: 2 });
  });

});
