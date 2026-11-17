/**
 * Shift A1 row references inside formulas after insert/delete rows.
 * Absolute rows ($1) are left alone. Sheet-qualified refs (Sheet1!A1) are
 * shifted when they target the same sheet or have no sheet qualifier.
 */

const A1_IN_FORMULA =
  /(^|[^A-Za-z0-9_])((?:'[^']+'|[A-Za-z_][\w.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)\b/g;

export function shiftFormulaRows(
  formula: string,
  at: number,
  deleteCount: number,
  insertCount: number,
  options: { shiftAbsolute?: boolean } = {},
): string {
  const delta = insertCount - deleteCount;
  if (!delta && deleteCount === 0) return formula;
  return formula.replace(
    A1_IN_FORMULA,
    (full, prefix: string, sheet: string | undefined, absCol: string, col: string, absRow: string, rowText: string) => {
      if (absRow === '$' && !options.shiftAbsolute) return full;
      const row = Number(rowText);
      if (!Number.isFinite(row)) return full;
      const head = `${prefix}${sheet ?? ''}`;
      if (deleteCount > 0 && row >= at && row < at + deleteCount) {
        return `${head}#REF!`;
      }
      if (row < at) return full;
      const next = row + delta;
      if (next < 1) return `${head}#REF!`;
      return `${head}${absCol}${col}${absRow}${next}`;
    },
  );
}
