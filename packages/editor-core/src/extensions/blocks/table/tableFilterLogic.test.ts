import { describe, expect, it } from 'vitest';
import { schema } from '../../../editor/EditorSchema';
import {
  collectColumnFilterValues,
  mergeColumnFilter,
  readTableFilters,
  rowPassesFilters,
} from './tableFilterLogic';

function header(text: string) {
  return schema.nodes.table_header.create(
    { colspan: 1, rowspan: 1, colwidth: null, alignment: null, verticalAlignment: null },
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
  );
}

function cell(text: string) {
  return schema.nodes.table_cell.create(
    { colspan: 1, rowspan: 1, colwidth: null, alignment: null, verticalAlignment: null },
    schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined),
  );
}

function sampleTable(filters: Array<{ col: number; selected: string[] }> | null = null) {
  return schema.nodes.table.create(
    { filters },
    [
      schema.nodes.table_row.create(null, [header('模块'), header('章节')]),
      schema.nodes.table_row.create(null, [cell('安全'), cell('总览')]),
      schema.nodes.table_row.create(null, [cell('网络'), cell('总览')]),
      schema.nodes.table_row.create(null, [cell('安全'), cell('详情')]),
    ],
  );
}

describe('tableFilterLogic', () => {
  it('collects unique data-column values and skips the header', () => {
    expect(collectColumnFilterValues(sampleTable(), 0)).toEqual(['安全', '网络']);
  });

  it('filters rows with AND across columns', () => {
    const table = sampleTable([{ col: 0, selected: ['安全'] }]);
    expect(rowPassesFilters(table, 0, readTableFilters(table))).toBe(true);
    expect(rowPassesFilters(table, 1, readTableFilters(table))).toBe(true);
    expect(rowPassesFilters(table, 2, readTableFilters(table))).toBe(false);
    expect(rowPassesFilters(table, 3, readTableFilters(table))).toBe(true);
  });

  it('clears a column filter when every value is selected', () => {
    const table = sampleTable([{ col: 0, selected: ['安全'] }]);
    expect(mergeColumnFilter(table, 0, ['安全', '网络'])).toBeNull();
  });

  it('keeps other columns when clearing one column', () => {
    const table = sampleTable([
      { col: 0, selected: ['安全'] },
      { col: 1, selected: ['总览'] },
    ]);
    expect(mergeColumnFilter(table, 0, ['安全', '网络'])).toEqual([{ col: 1, selected: ['总览'] }]);
  });
});
