/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import { docToMarkdown } from './MarkdownSerializer';
import { createParser, parseMarkdown } from './MarkdownParser';

const parser = createParser();

/**
 * Simulates the reported failure: the AI rewrites the table body (adds a row /
 * changes rowspans) while the `easyview:table-meta` still describes the OLD
 * structure. Parsing must still restore the saved column widths (by logical
 * column) and row heights (by row index), and saving must persist them again
 * — both in the meta and as self-contained HTML attributes.
 */
describe('table meta round-trip after a structural edit', () => {
  it('restores and re-persists column widths and row heights when the shape changed', () => {
    // Body: 3 rows now (one row was inserted). Meta: stale, 2-row shape,
    // header-row cells carry the old column widths, rowHeights for 2 rows.
    const markdown = `<table>
<tr><th>名称</th><th>说明</th></tr>
<tr><td>数据采集</td><td>采集说明</td></tr>
<tr><td>新增行</td><td>新数据</td></tr>
</table>

<!-- easyview:table-meta {"version":1,"tables":[{"shape":[2,2],"cells":[{"row":0,"cell":0,"colwidth":[320]},{"row":0,"cell":1,"colwidth":[180]}],"rowHeights":[46,120]}]} -->`;

    const doc = parseMarkdown(markdown, parser)!;
    const table = doc.firstChild!;
    expect(table.type.name).toBe('table');
    expect(table.childCount).toBe(3);

    // Column widths restored into every cell by logical column.
    expect(table.child(0).child(0).attrs.colwidth).toEqual([320]);
    expect(table.child(0).child(1).attrs.colwidth).toEqual([180]);
    expect(table.child(1).child(0).attrs.colwidth).toEqual([320]);
    expect(table.child(2).child(0).attrs.colwidth).toEqual([320]);

    // Row heights restored by index; the inserted row keeps auto height.
    expect(table.child(0).attrs.height).toBe(46);
    expect(table.child(1).attrs.height).toBe(120);
    expect(table.child(2).attrs.height).toBeNull();

    const serialized = docToMarkdown(doc);

    // Widths/heights are now self-contained in the HTML attributes.
    expect(serialized).toContain('data-colwidth="320"');
    expect(serialized).toContain('data-colwidth="180"');
    expect(serialized).toContain('data-easyview-row-height="46"');
    expect(serialized).toContain('data-easyview-row-height="120"');

    // Meta regenerated: table-level colWidths + 3 row heights.
    const metaMatch = serialized.match(/easyview:table-meta (\{[\s\S]*?\}) -->/);
    expect(metaMatch).not.toBeNull();
    const meta = JSON.parse(metaMatch![1]);
    const entry = meta.tables[0];
    expect(entry.colWidths).toEqual([320, 180]);
    expect(entry.rowHeights).toEqual([46, 120, 0]);
    expect(entry.shape).toEqual([2, 2, 2]);
  });
});
