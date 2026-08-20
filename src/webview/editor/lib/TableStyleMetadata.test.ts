import { describe, expect, it } from 'vitest';

import { schema } from '../EditorSchema';
import {
  applyEasyViewTableMeta,
  collectEasyViewTableMeta,
  type EasyViewTableMeta,
} from './TableStyleMetadata';

function cell(text: string, colwidth: number[] | null = null) {
  return schema.nodes.table_cell.create(
    { colspan: 1, rowspan: 1, colwidth, alignment: null, verticalAlignment: null },
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined)
  );
}

function table(rows: Array<{ height?: number | null; cells: ReturnType<typeof cell>[] }>) {
  return schema.nodes.table.create(
    null,
    rows.map(({ height = null, cells }) => schema.nodes.table_row.create({ height }, cells))
  );
}

function docWithTable(rows: Array<{ height?: number | null; cells: ReturnType<typeof cell>[] }>) {
  return schema.nodes.doc.create(null, [table(rows)]);
}

describe('EasyView table style metadata', () => {
  it('stores row heights even when a table has no manual column widths', () => {
    const doc = docWithTable([
      { height: 84, cells: [cell('a'), cell('b')] },
      { cells: [cell('c'), cell('d')] },
    ]);

    expect(collectEasyViewTableMeta(doc)).toEqual({
      version: 1,
      tables: [{ shape: [2, 2], cells: [], rowHeights: [84, 0] }],
    });
  });

  it('restores row heights together with column widths', () => {
    const doc = docWithTable([
      { cells: [cell('a'), cell('b')] },
      { cells: [cell('c'), cell('d')] },
    ]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{
        shape: [2, 2],
        cells: [{ row: 0, cell: 1, colwidth: [180] }],
        rowHeights: [96, 140],
      }],
    };

    const restored = applyEasyViewTableMeta(doc, meta);
    const restoredTable = restored.firstChild!;
    expect(restoredTable.child(0).attrs.height).toBe(96);
    expect(restoredTable.child(1).attrs.height).toBe(140);
    expect(restoredTable.child(0).child(1).attrs.colwidth).toEqual([180]);
  });

  it('does not apply row heights if the table shape changed', () => {
    const doc = docWithTable([{ cells: [cell('a')] }]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{ shape: [2], cells: [], rowHeights: [100, 120] }],
    };

    expect(applyEasyViewTableMeta(doc, meta).firstChild!.child(0).attrs.height).toBeNull();
  });

  it('keeps documents with legacy metadata that has no rowHeights compatible', () => {
    const doc = docWithTable([{ height: 76, cells: [cell('a')] }]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{ shape: [1], cells: [] }],
    };

    expect(applyEasyViewTableMeta(doc, meta).firstChild!.child(0).attrs.height).toBe(76);
  });
});
