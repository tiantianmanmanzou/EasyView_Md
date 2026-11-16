/**
 * Build a new .xlsx from a simple table payload (markdown/editor export).
 * No ExcelJS — emits OPC parts directly.
 */

import JSZip from 'jszip';
import { cellRef, columnLetter } from './refs';

export interface TableExportCell {
  row: number;
  col: number;
  text: string;
  alignment?: string | null;
  verticalAlignment?: string | null;
  isHeader?: boolean;
}

export interface TableExportPayload {
  cells: TableExportCell[];
  merges?: Array<{ top: number; left: number; bottom: number; right: number }>;
  columnWidths?: number[];
  rowHeights?: number[];
  totalCols?: number;
  totalRows?: number;
}

function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function horizontal(align: string | null | undefined): string | undefined {
  switch ((align || '').toLowerCase()) {
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'justify':
      return 'justify';
    case 'left':
    case 'start':
      return 'left';
    default:
      return undefined;
  }
}

function vertical(align: string | null | undefined): string | undefined {
  switch ((align || '').toLowerCase()) {
    case 'bottom':
    case 'end':
      return 'bottom';
    case 'middle':
    case 'center':
      return 'center';
    case 'top':
    case 'start':
      return 'top';
    default:
      return undefined;
  }
}

/** px → Excel character width (approx MDW=7). */
function pxToExcelWidth(px: number): number {
  return Math.max(4, Math.round(px / 7));
}

/** CSS px → Excel points. */
function pxToPoints(px: number): number {
  return Math.max(10, Math.round(px * 0.75));
}

export async function buildXlsxFromTable(payload: TableExportPayload): Promise<Uint8Array> {
  // Style 0: normal with thin gray border + wrap
  // Style 1: header = style 0 + bold
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FF999999"/></left>
      <right style="thin"><color rgb="FF999999"/></right>
      <top style="thin"><color rgb="FF999999"/></top>
      <bottom style="thin"><color rgb="FF999999"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1"/></xf>
  </cellXfs>
</styleSheet>`;

  const byRow = new Map<number, TableExportCell[]>();
  for (const cell of payload.cells) {
    const list = byRow.get(cell.row) ?? [];
    list.push(cell);
    byRow.set(cell.row, list);
  }
  const rowIndexes = [...byRow.keys()].sort((a, b) => a - b);
  const sheetRows: string[] = [];
  for (const ri of rowIndexes) {
    const cells = byRow.get(ri)!.sort((a, b) => a.col - b.col);
    const height = payload.rowHeights?.[ri];
    const heightAttr =
      typeof height === 'number' && height > 0 ? ` ht="${pxToPoints(height)}" customHeight="1"` : '';
    const parts = [`<row r="${ri + 1}"${heightAttr}>`];
    for (const cell of cells) {
      const styleId = cell.isHeader ? 1 : 0;
      const h = horizontal(cell.alignment);
      const v = vertical(cell.verticalAlignment);
      // Per-cell alignment overrides go in a dedicated xf when needed; keep export simple with shared xfs.
      void h;
      void v;
      parts.push(
        `<c r="${cellRef(cell.col + 1, cell.row + 1)}" s="${styleId}" t="inlineStr"><is><t>${encodeXmlText(cell.text)}</t></is></c>`,
      );
    }
    parts.push('</row>');
    sheetRows.push(parts.join(''));
  }

  const colWidths = payload.columnWidths ?? [];
  const colXml = colWidths.length
    ? `<cols>${colWidths
        .map((w, i) =>
          typeof w === 'number' && w > 0
            ? `<col min="${i + 1}" max="${i + 1}" width="${pxToExcelWidth(w)}" customWidth="1"/>`
            : '',
        )
        .join('')}</cols>`
    : '';

  const merges = (payload.merges ?? []).filter((m) => m.bottom >= m.top && m.right >= m.left);
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges
        .map((m) => {
          const start = `${columnLetter(m.left + 1)}${m.top + 1}`;
          const end = `${columnLetter(m.right + 1)}${m.bottom + 1}`;
          return `<mergeCell ref="${start}:${end}"/>`;
        })
        .join('')}</mergeCells>`
    : '';

  const maxRow = Math.max(1, ...(payload.cells.map((c) => c.row + 1)), payload.totalRows ?? 1);
  const maxCol = Math.max(1, ...(payload.cells.map((c) => c.col + 1)), payload.totalCols ?? 1);
  const dim = `A1:${columnLetter(maxCol)}${maxRow}`;

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dim}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${colXml}
  <sheetData>${sheetRows.join('')}</sheetData>
  ${mergeXml}
</worksheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('xl/workbook.xml', workbook);
  zip.file('xl/_rels/workbook.xml.rels', workbookRels);
  zip.file('xl/worksheets/sheet1.xml', sheet);
  zip.file('xl/styles.xml', styles);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
