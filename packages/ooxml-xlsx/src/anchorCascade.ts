/**
 * Cascade defined names and drawing/chart anchors when rows are inserted/deleted.
 * Excel stores drawing anchors as 0-based row indices in xdr:from / xdr:to.
 * Defined names use A1 row numbers in workbook.xml.
 */

import { shiftFormulaRows } from './formulaShift';

/** Shift a 0-based drawing/chart row index. */
export function shiftAnchorRow(
  row: number,
  at: number,
  deleteCount: number,
  insertCount: number,
): number | null {
  // `at` is 1-based Excel row; anchors are 0-based.
  const at0 = at - 1;
  if (deleteCount > 0 && row >= at0 && row < at0 + deleteCount) return null;
  if (row < at0) return row;
  return row + insertCount - deleteCount;
}

/**
 * Rewrite xdr:row / a:row values inside a drawing or chart drawing part.
 * Returns null when an anchor's from-row lands in a deleted range (caller may drop the anchor).
 */
export function shiftDrawingXmlRows(
  xml: string,
  at: number,
  deleteCount: number,
  insertCount: number,
): string {
  return xml.replace(/<(?:xdr:|a:)?row>(\d+)<\/(?:xdr:|a:)?row>/g, (full, rowText: string) => {
    const row = Number(rowText);
    if (!Number.isFinite(row)) return full;
    const next = shiftAnchorRow(row, at, deleteCount, insertCount);
    if (next === null) return full; // leave; structural drop of whole anchors is best-effort below
    if (next === row) return full;
    return full.replace(String(row), String(Math.max(0, next)));
  });
}

/** Drop twoCellAnchor / oneCellAnchor blocks whose from-row is inside a deleted range. */
export function dropAnchorsInDeletedRows(
  xml: string,
  at: number,
  deleteCount: number,
): string {
  if (deleteCount <= 0) return xml;
  const at0 = at - 1;
  const end0 = at0 + deleteCount;
  return xml.replace(
    /<(xdr:(?:twoCellAnchor|oneCellAnchor|absoluteAnchor))\b[\s\S]*?<\/\1>/g,
    (block) => {
      const fromRow = Number(/<(?:xdr:)?from>[\s\S]*?<(?:xdr:)?row>(\d+)/.exec(block)?.[1]);
      if (Number.isFinite(fromRow) && fromRow >= at0 && fromRow < end0) return '';
      return block;
    },
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a defined name body targets the given sheet (or has no sheet qualifier). */
export function definedNameTargetsSheet(
  body: string,
  sheetName: string,
  localSheetId: number | undefined,
  sheetIndex: number,
): boolean {
  if (localSheetId !== undefined && localSheetId === sheetIndex) return true;
  const quoted = `'${sheetName.replace(/'/g, "''")}'`;
  const bare = sheetName;
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_])(?:${escapeRegExp(quoted)}|${escapeRegExp(bare)})!`,
    'i',
  );
  if (pattern.test(body)) return true;
  // Workbook-scoped name with no sheet prefix: only touch if it looks like a plain A1 range.
  if (localSheetId === undefined && !/[!]/.test(body) && /[A-Z]+\d+/i.test(body)) return false;
  return false;
}

/**
 * Rewrite definedName bodies in workbook.xml for A1 row shifts on one sheet.
 * `sheetIndex` is 0-based and matches localSheetId when present.
 */
export function shiftDefinedNamesXml(
  workbookXml: string,
  sheetName: string,
  sheetIndex: number,
  at: number,
  deleteCount: number,
  insertCount: number,
): string {
  if (!/<definedNames\b/.test(workbookXml)) return workbookXml;
  return workbookXml.replace(
    /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g,
    (full, attrs: string, body: string) => {
      const localRaw = /\blocalSheetId="(\d+)"/.exec(attrs)?.[1];
      const localSheetId = localRaw !== undefined ? Number(localRaw) : undefined;
      if (!definedNameTargetsSheet(body, sheetName, localSheetId, sheetIndex)) return full;
      // Named ranges follow sheet row inserts even for $absolute refs.
      const next = shiftFormulaRows(body, at, deleteCount, insertCount, { shiftAbsolute: true });
      if (next === body) return full;
      return `<definedName${attrs}>${next}</definedName>`;
    },
  );
}
