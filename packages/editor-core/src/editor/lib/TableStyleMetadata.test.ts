import { describe, expect, it } from 'vitest';

import { schema } from '../EditorSchema';
import {
  applyEasyViewTableMeta,
  collectEasyViewTableMeta,
  type EasyViewTableMeta,
} from '@easyview/markdown-core/table-style-metadata';

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

  it('restores row heights by index even when the table shape changed', () => {
    const doc = docWithTable([{ cells: [cell('a')] }]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{ shape: [2], cells: [], rowHeights: [100, 120] }],
    };

    const restored = applyEasyViewTableMeta(doc, meta).firstChild!;
    expect(restored.child(0).attrs.height).toBe(100);
  });

  it('keeps rows beyond the saved metadata at their current height', () => {
    const doc = docWithTable([{ cells: [cell('a')] }, { cells: [cell('b')] }]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{ shape: [1], cells: [], rowHeights: [100] }],
    };

    const restored = applyEasyViewTableMeta(doc, meta).firstChild!;
    expect(restored.child(0).attrs.height).toBe(100);
    expect(restored.child(1).attrs.height).toBeNull();
  });

  it('collects table-level logical column widths from the first row', () => {
    const doc = docWithTable([
      { cells: [cell('a', [320]), cell('b', [180])] },
      { cells: [cell('c', [320]), cell('d', [180])] },
    ]);

    expect(collectEasyViewTableMeta(doc)).toEqual({
      version: 1,
      tables: [{
        shape: [2, 2],
        cells: [
          { row: 0, cell: 0, colwidth: [320] },
          { row: 0, cell: 1, colwidth: [180] },
          { row: 1, cell: 0, colwidth: [320] },
          { row: 1, cell: 1, colwidth: [180] },
        ],
        colWidths: [320, 180],
      }],
    });
  });

  it('restores column widths by logical column when the shape changed', () => {
    const doc = docWithTable([
      { cells: [cell('a'), cell('b')] },
      { cells: [cell('c')] },
    ]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{ shape: [2, 2], cells: [], colWidths: [300, 180] }],
    };

    const restored = applyEasyViewTableMeta(doc, meta).firstChild!;
    expect(restored.child(0).child(0).attrs.colwidth).toEqual([300]);
    expect(restored.child(0).child(1).attrs.colwidth).toEqual([180]);
    expect(restored.child(1).child(0).attrs.colwidth).toEqual([300]);
  });

  it('derives column widths from legacy header-row cells when the shape changed', () => {
    const doc = docWithTable([
      { cells: [cell('a'), cell('b')] },
      { cells: [cell('c')] },
    ]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{
        shape: [2, 2],
        cells: [
          { row: 0, cell: 0, colwidth: [300] },
          { row: 0, cell: 1, colwidth: [180] },
        ],
      }],
    };

    const restored = applyEasyViewTableMeta(doc, meta).firstChild!;
    expect(restored.child(1).child(0).attrs.colwidth).toEqual([300]);
    expect(restored.child(0).child(1).attrs.colwidth).toEqual([180]);
  });

  it('applies logical column widths to colspan cells', () => {
    const wide = schema.nodes.table_cell.create(
      { colspan: 2, rowspan: 1, colwidth: null, alignment: null, verticalAlignment: null },
      schema.nodes.paragraph.create(null, schema.text('ab'))
    );
    const doc = docWithTable([
      { cells: [wide] },
      { cells: [cell('c'), cell('d')] },
    ]);
    const meta: EasyViewTableMeta = {
      version: 1,
      tables: [{ shape: [1, 2], cells: [], colWidths: [300, 180] }],
    };

    const restored = applyEasyViewTableMeta(doc, meta).firstChild!;
    expect(restored.child(0).child(0).attrs.colwidth).toEqual([300, 180]);
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
