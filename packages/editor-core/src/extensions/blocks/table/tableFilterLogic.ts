/**
 * View-layer Markdown table filters: hide rows without deleting pipe-table source.
 * Criteria live on table.attrs.filters and round-trip via easyview:table-meta.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import {
  normalizeTableFilters,
  type EasyViewTableColumnFilter,
} from '@easyview/markdown-core/table-style-metadata';

export type { EasyViewTableColumnFilter };

export function readTableFilters(table: ProsemirrorNode): EasyViewTableColumnFilter[] {
  return normalizeTableFilters(table.attrs.filters, TableMap.get(table).width) ?? [];
}

export function cellTextAt(table: ProsemirrorNode, row: number, col: number): string {
  const map = TableMap.get(table);
  if (row < 0 || row >= map.height || col < 0 || col >= map.width) return '';
  const cell = table.nodeAt(map.map[row * map.width + col]);
  return cell?.textContent ?? '';
}

/** Unique values in a data column (skips header row 0), sorted for stable UI. */
export function collectColumnFilterValues(table: ProsemirrorNode, col: number): string[] {
  const map = TableMap.get(table);
  const values = new Set<string>();
  for (let row = 1; row < map.height; row += 1) {
    values.add(cellTextAt(table, row, col));
  }
  return [...values].sort((a, b) => {
    if (a === '' && b !== '') return 1;
    if (b === '' && a !== '') return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function rowPassesFilters(
  table: ProsemirrorNode,
  row: number,
  filters: EasyViewTableColumnFilter[],
): boolean {
  if (row === 0 || filters.length === 0) return true;
  for (const filter of filters) {
    const text = cellTextAt(table, row, filter.col);
    if (!filter.selected.includes(text)) return false;
  }
  return true;
}

/** Merge one column's selection into the table filter list. All-selected → clear that column. */
export function mergeColumnFilter(
  table: ProsemirrorNode,
  col: number,
  selected: string[],
): EasyViewTableColumnFilter[] | null {
  const allValues = collectColumnFilterValues(table, col);
  const uniqueSelected = [...new Set(selected.filter((item) => typeof item === 'string'))];
  const selectsAll =
    allValues.length === uniqueSelected.length && allValues.every((value) => uniqueSelected.includes(value));

  const others = readTableFilters(table).filter((item) => item.col !== col);
  if (!selectsAll) {
    others.push({ col, selected: uniqueSelected });
    others.sort((a, b) => a.col - b.col);
  }
  return others.length > 0 ? others : null;
}

export function columnFilterIsActive(table: ProsemirrorNode, col: number): boolean {
  return readTableFilters(table).some((item) => item.col === col);
}
