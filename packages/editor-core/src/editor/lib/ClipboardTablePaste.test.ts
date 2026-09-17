import { JSDOM } from 'jsdom';
import { describe, expect, it, beforeAll } from 'vitest';

import { schema } from '../EditorSchema';
import {
  looksLikeSpreadsheetTsv,
  parseClipboardAsNestedTable,
  parseHtmlTable,
  parseTsvTable,
  shouldPasteClipboardAsNestedTable,
  unwrapCellWrapperTableFragment,
  unwrapCellWrapperTablesInClipboardHtml,
  unmergeTablesInClipboardHtml,
} from './ClipboardTablePaste';

beforeAll(() => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  (globalThis as any).DOMParser = dom.window.DOMParser;
  (globalThis as any).document = dom.window.document;
});

function cellTexts(table: ReturnType<typeof parseTsvTable>): string[][] {
  const rows: string[][] = [];
  table!.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  return rows;
}

function cellSpans(table: ReturnType<typeof parseTsvTable>): Array<Array<[number, number]>> {
  const rows: Array<Array<[number, number]>> = [];
  table!.forEach((row) => {
    const cells: Array<[number, number]> = [];
    row.forEach((cell) => cells.push([cell.attrs.rowspan || 1, cell.attrs.colspan || 1]));
    rows.push(cells);
  });
  return rows;
}

describe('ClipboardTablePaste', () => {
  it('detects Excel-like TSV', () => {
    expect(looksLikeSpreadsheetTsv('a\tb\nc\td')).toBe(true);
    expect(looksLikeSpreadsheetTsv('a\tb\tc')).toBe(true);
    expect(looksLikeSpreadsheetTsv('plain\ntext')).toBe(false);
  });

  it('parses TSV into a nested table with a header row', () => {
    const table = parseTsvTable('Name\tAge\nAda\t36\nBob\t41', schema);
    expect(table?.type.name).toBe('table');
    expect(table!.child(0).child(0).type.name).toBe('table_header');
    expect(table!.child(1).child(0).type.name).toBe('table_cell');
    expect(cellTexts(table)).toEqual([
      ['Name', 'Age'],
      ['Ada', '36'],
      ['Bob', '41'],
    ]);
  });

  it('parses Excel HTML fragment into a table', () => {
    const html = `<html><body><!--StartFragment-->
<table border="0">
 <tr><td>A1</td><td>B1</td></tr>
 <tr><td>A2</td><td>B2</td></tr>
</table>
<!--EndFragment--></body></html>`;

    const table = parseHtmlTable(html, schema);
    expect(table?.type.name).toBe('table');
    expect(cellTexts(table)).toEqual([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ]);
  });

  it('parses Excel-style HTML with spans and mso markup', () => {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office">
<body>
<!--StartFragment-->
<table border=0 cellpadding=0 cellspacing=0>
 <tr>
  <td style='padding:0'><span style='font-size:12pt'>产品</span></td>
  <td style='padding:0'><span>数量</span></td>
 </tr>
 <tr>
  <td><span>苹果</span></td>
  <td><span>3</span></td>
 </tr>
</table>
<!--EndFragment-->
</body></html>`;

    const table = parseHtmlTable(html, schema);
    expect(cellTexts(table)).toEqual([
      ['产品', '数量'],
      ['苹果', '3'],
    ]);
  });

  it('expands vertically merged Excel cells into every covered row', () => {
    const html = `<html><body><!--StartFragment-->
<table border=0>
 <tr>
  <td>二级功能</td>
  <td>三级功能</td>
  <td>功能描述</td>
 </tr>
 <tr>
  <td rowspan=3>数据资源画像</td>
  <td>连接信息展示</td>
  <td>展示数据资源的连接信息</td>
 </tr>
 <tr>
  <td>基准信息统计</td>
  <td>统计基准信息</td>
 </tr>
 <tr>
  <td>基准差异数据统计</td>
  <td>统计基准差异</td>
 </tr>
</table>
<!--EndFragment--></body></html>`;

    const table = parseHtmlTable(html, schema);
    expect(cellTexts(table)).toEqual([
      ['二级功能', '三级功能', '功能描述'],
      ['数据资源画像', '连接信息展示', '展示数据资源的连接信息'],
      ['数据资源画像', '基准信息统计', '统计基准信息'],
      ['数据资源画像', '基准差异数据统计', '统计基准差异'],
    ]);
    expect(cellSpans(table).flat()).toEqual(Array(12).fill([1, 1]));
  });

  it('expands horizontally merged Excel cells into every covered column', () => {
    const html = `<table>
 <tr><td colspan="2">标题</td><td>备注</td></tr>
 <tr><td>A</td><td>B</td><td>C</td></tr>
</table>`;

    const table = parseHtmlTable(html, schema);
    expect(cellTexts(table)).toEqual([
      ['标题', '标题', '备注'],
      ['A', 'B', 'C'],
    ]);
  });

  it('expands a cell that is merged both across rows and columns', () => {
    const html = `<table>
 <tr><td rowspan="2" colspan="2">合并</td><td>右上</td></tr>
 <tr><td>右下</td></tr>
 <tr><td>左下</td><td>中下</td><td>右下2</td></tr>
</table>`;

    const table = parseHtmlTable(html, schema);
    expect(cellTexts(table)).toEqual([
      ['合并', '合并', '右上'],
      ['合并', '合并', '右下'],
      ['左下', '中下', '右下2'],
    ]);
  });

  it('prefers expanded HTML merges over TSV rows that omit merged values', () => {
    const html = `<table>
 <tr><td>二级功能</td><td>三级功能</td></tr>
 <tr><td rowspan="2">数据资源画像</td><td>连接信息展示</td></tr>
 <tr><td>基准信息统计</td></tr>
</table>`;
    const tsv = '二级功能\t三级功能\n数据资源画像\t连接信息展示\n\t基准信息统计';

    const table = parseClipboardAsNestedTable(html, tsv, schema);
    expect(cellTexts(table)).toEqual([
      ['二级功能', '三级功能'],
      ['数据资源画像', '连接信息展示'],
      ['数据资源画像', '基准信息统计'],
    ]);
  });

  it('prefers HTML table and falls back to TSV', () => {
    const html = `<table><tr><td>H1</td><td>H2</td></tr><tr><td>V1</td><td>V2</td></tr></table>`;
    const fromHtml = parseClipboardAsNestedTable(html, 'ignored\trow', schema);
    expect(cellTexts(fromHtml)).toEqual([
      ['H1', 'H2'],
      ['V1', 'V2'],
    ]);

    const fromTsv = parseClipboardAsNestedTable(undefined, 'A\tB\nC\tD', schema);
    expect(cellTexts(fromTsv)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
  });

  it('strips rowspan/colspan from clipboard HTML before default paste', () => {
    const html = `<table>
 <tr><td rowspan="3">数据资源画像</td><td>连接信息展示</td></tr>
 <tr><td>基准信息统计</td></tr>
 <tr><td>基准差异数据统计</td></tr>
</table>`;
    const unmerged = unmergeTablesInClipboardHtml(html);
    expect(unmerged).not.toMatch(/rowspan/i);
    expect(unmerged).not.toMatch(/colspan/i);
    expect(unmerged.match(/数据资源画像/g)).toHaveLength(3);
  });

  it('unwraps marked single-cell editor copies but keeps nested tables', () => {
    const proseCellCopy = `<table data-easyview-cell-copy="1" class="ProseMirror"><tr><td><div class="easyview-table-cell-content"><h3>标题</h3><ul><li>条目</li></ul></div></td></tr></table>`;
    const unwrapped = unwrapCellWrapperTablesInClipboardHtml(proseCellCopy);
    expect(unwrapped).toContain('<h3');
    expect(unwrapped).toContain('<ul>');
    expect(unwrapped).not.toContain('<table');

    const nestedTableCopy = `<table class="ProseMirror"><tr><td><div class="easyview-table-cell-content"><div class="table-wrapper"><table><tr><td><div class="easyview-table-cell-content"><p>A</p></div></td><td><div class="easyview-table-cell-content"><p>B</p></div></td></tr></table></div></div></td></tr></table>`;
    expect(unwrapCellWrapperTablesInClipboardHtml(nestedTableCopy)).toBe(nestedTableCopy);
  });

  it('detects when cell paste should stay formatted prose vs become nested table', () => {
    const proseCellCopy = `<table class="ProseMirror"><tr><td><div class="easyview-table-cell-content"><h3>标题</h3><p>正文</p></div></td></tr></table>`;
    expect(shouldPasteClipboardAsNestedTable(proseCellCopy, '### 标题\n正文', schema)).toBe(false);

    const tableOnlyCellCopy = `<table class="ProseMirror"><tr><td><div class="easyview-table-cell-content"><div class="table-wrapper"><table><tr><td>A</td><td>B</td></tr></table></div></div></td></tr></table>`;
    expect(shouldPasteClipboardAsNestedTable(tableOnlyCellCopy, 'ignored', schema)).toBe(true);

    const excelHtml = `<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>`;
    expect(shouldPasteClipboardAsNestedTable(excelHtml, 'A\tB\nC\tD', schema)).toBe(true);
  });

  it('unwraps 1x1 cell-wrapper fragments to cell content', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('hello'));
    const cell = schema.nodes.table_cell.create(null, paragraph);
    const row = schema.nodes.table_row.create(null, cell);
    const wrapper = schema.nodes.table.create(null, row);
    const doc = schema.nodes.doc.create(null, wrapper);
    const fragment = doc.content;
    const unwrapped = unwrapCellWrapperTableFragment(fragment);
    expect(unwrapped.childCount).toBe(1);
    expect(unwrapped.firstChild?.type.name).toBe('paragraph');
    expect(unwrapped.firstChild?.textContent).toBe('hello');
  });
});
