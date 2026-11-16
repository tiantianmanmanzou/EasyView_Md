import { describe, expect, it, vi } from 'vitest';
import {
  attachSpreadsheetFilter,
  patchExceptRowTotalHeight,
} from './spreadsheetFilter';

describe('attachSpreadsheetFilter', () => {
  it('applies the filter without sort and scrolls the sheet back to the top', () => {
    const setAutoFilter = vi.fn();
    const move = vi.fn();
    const reload = vi.fn();
    const previousOk = vi.fn();
    const scroll = { ri: 40, y: 800 };
    const sortFilter = { ok: previousOk };
    const spreadsheet = {
      sheet: {
        sortFilter,
        data: {
          setAutoFilter,
          scroll,
          exceptRowSet: new Set<number>(),
          rows: { getHeight: () => 25 },
        },
        verticalScrollbar: { move },
        reload,
      },
    };

    const dispose = attachSpreadsheetFilter(spreadsheet as never);
    sortFilter.ok?.(3, 'asc', 'in', ['数据安全中台']);

    expect(setAutoFilter).toHaveBeenCalledWith(3, null, 'in', ['数据安全中台']);
    expect(scroll).toEqual({ ri: 0, y: 0 });
    expect(move).toHaveBeenCalledWith({ top: 0 });
    expect(reload).toHaveBeenCalled();
    expect(previousOk).not.toHaveBeenCalled();

    dispose();
    expect(sortFilter.ok).toBe(previousOk);
  });

  it('is a no-op when the sheet has no filter menu', () => {
    expect(attachSpreadsheetFilter({ sheet: {} } as never)).toEqual(expect.any(Function));
  });
});

describe('patchExceptRowTotalHeight', () => {
  it('ignores hidden rows below the view when painting, but keeps them for the scrollbar sentinel', () => {
    const data = {
      exceptRowSet: new Set([2, 5, 40, 50]),
      rows: { getHeight: () => 25 },
    };
    patchExceptRowTotalHeight(data);
    // View starting at row 3: only row 2 (above) counts — not 40/50 below.
    expect(data.exceptRowTotalHeight?.(3, 20)).toBe(25);
    // Scrollbar sentinel (0, -1): every hidden row.
    expect(data.exceptRowTotalHeight?.(0, -1)).toBe(100);
  });
});
