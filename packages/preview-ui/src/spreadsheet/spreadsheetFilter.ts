/**
 * Filter-menu tweaks for x-data-spreadsheet:
 * - After OK, jump the grid back to the top so collapsed rows are not scrolled out of view.
 * - Ignore Sort A→Z / Z→A (the menu items are also hidden in CSS).
 * - Fix exceptRowTotalHeight so filtered rows below the viewport do not push cell text off-canvas.
 */

import type { XsSpreadsheetLike } from './xSpreadsheetTypes';

type SortFilterOk = (ci: number, order: string | null, operator: string, value: unknown) => void;

interface SortFilterLike {
  ok?: SortFilterOk;
}

interface FilterData {
  exceptRowSet?: Set<number>;
  rows?: { getHeight(index: number): number };
  exceptRowTotalHeight?: (sri: number, eri: number) => number;
  setAutoFilter?: (ci: number, order: string | null, operator: string, value: unknown) => void;
  scroll?: { ri: number; y: number };
}

interface SheetFilterHost {
  sortFilter?: SortFilterLike;
  data?: FilterData;
  verticalScrollbar?: { move?: (offset: { top: number }) => void };
  reload?: () => void;
}

const EXCEPT_HEIGHT_FLAG = '__easyviewExceptRowHeight';

/**
 * x-data-spreadsheet sums every hidden row outside the current view into the paint
 * offset, including rows *below* the viewport. That shifts cell text above the clip
 * while row headers (which walk visible rows only) still look correct — a blank grid.
 * Scrollbar setup calls this with (0, -1) and still needs the full hidden height.
 */
export function patchExceptRowTotalHeight(data: FilterData | null | undefined): void {
  if (!data?.rows || !data.exceptRowSet) return;
  const tagged = data as FilterData & { [EXCEPT_HEIGHT_FLAG]?: boolean };
  if (tagged[EXCEPT_HEIGHT_FLAG]) return;
  data.exceptRowTotalHeight = function exceptRowTotalHeight(sri: number, eri: number) {
    let height = 0;
    const rows = this.rows;
    if (!rows) return 0;
    this.exceptRowSet?.forEach((ri) => {
      // (0, -1) from verticalScrollbarSet: eri < sri means "all hidden rows".
      if (eri < sri || ri < sri) height += rows.getHeight(ri);
    });
    return height;
  };
  tagged[EXCEPT_HEIGHT_FLAG] = true;
}

/** Patch every sheet data proxy the workbook currently holds. */
export function patchSpreadsheetFilterRender(spreadsheet: XsSpreadsheetLike | null | undefined): void {
  if (!spreadsheet) return;
  if (Array.isArray(spreadsheet.datas)) {
    for (const data of spreadsheet.datas) patchExceptRowTotalHeight(data as unknown as FilterData);
  }
  if (spreadsheet.data) patchExceptRowTotalHeight(spreadsheet.data as unknown as FilterData);
  const sheetData = spreadsheet.sheet?.data;
  if (sheetData) patchExceptRowTotalHeight(sheetData as unknown as FilterData);
}

/** Wire filter OK to drop sort and scroll to the first visible row. */
export function attachSpreadsheetFilter(spreadsheet: XsSpreadsheetLike): () => void {
  patchSpreadsheetFilterRender(spreadsheet);
  const sheet = spreadsheet.sheet as SheetFilterHost | undefined;
  const sortFilter = sheet?.sortFilter;
  if (!sheet || !sortFilter || typeof sheet.data?.setAutoFilter !== 'function') return () => {};

  const previousOk = sortFilter.ok;
  sortFilter.ok = (ci, _order, operator, value) => {
    patchExceptRowTotalHeight(sheet.data);
    sheet.data?.setAutoFilter?.(ci, null, operator, value);
    if (sheet.data?.scroll) {
      sheet.data.scroll.ri = 0;
      sheet.data.scroll.y = 0;
    }
    sheet.verticalScrollbar?.move?.({ top: 0 });
    sheet.reload?.();
  };

  return () => {
    sortFilter.ok = previousOk;
  };
}
