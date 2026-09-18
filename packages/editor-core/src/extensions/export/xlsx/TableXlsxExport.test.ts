/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { EditorHostTransport } from '@easyview/contracts';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import { buildTableXlsxPayload, exportTableToXlsx } from './TableXlsxExport';
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

describe('exportTableToXlsx', () => {
  it('sends the payload through the explicitly supplied host', () => {
    const view = viewFor(`<table><tr><td>A</td></tr></table>`);
    const postMessage = vi.fn();
    const host: EditorHostTransport = {
      capabilities: {
      sourceMode: 'embedded',
      git: false,
      terminal: false,
      aiCommitMessage: false,
      aiChat: false,
      documentConversion: false,
      shortcutPersistence: false,
    },
      postMessage,
      subscribe: () => ({ unsubscribe: () => undefined }),
    };

    expect(exportTableToXlsx({ fileName: 'table.xlsx', runtime: {
      getEditorView: () => view,
      host,
    } })(view.state, view.dispatch)).toBe(true);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'exportXlsx',
      fileName: 'table.xlsx',
    }));
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

  it('exports nested tables as GFM pipe markdown in the host cell', () => {
    const markdown = `<table>
<tr><td>外层</td><td>
<table>
<tr><th data-colwidth="98">状态大类</th><th data-colwidth="155">状态小类</th></tr>
<tr><td data-colwidth="98">库状态</td><td data-colwidth="155">库</td></tr>
</table>
</td></tr>
</table>`;
    const doc = parseMarkdown(markdown, createParser())!;
    const view = new EditorView(document.createElement('div'), { state: EditorState.create({ doc }) });
    // Select the outer "外层" cell so selectedRect is the host table.
    let pos = -1;
    doc.descendants((node, offset) => {
      if (pos >= 0) return false;
      if ((node.type.name === 'table_cell' || node.type.name === 'table_header') && node.textContent === '外层') {
        pos = offset + 1;
        return false;
      }
      return true;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));

    const payload = buildTableXlsxPayload(view.state);
    expect(payload.totalCols).toBe(2);
    const nestedCell = payload.cells.find((c) => c.row === 0 && c.col === 1)!;
    expect(nestedCell.text).toMatch(/\|\s*状态大类\s*\|\s*状态小类\s*\|/);
    expect(nestedCell.text).toMatch(/\|\s*库状态\s*\|\s*库\s*\|/);
    expect(nestedCell.text).not.toContain('<table>');
  });
});
