import ExcelJS from "exceljs";
import type { XlsxTablePayload } from "@easyview/contracts";

type ExcelHorizontal = "left" | "center" | "right" | "justify";
type ExcelVertical = "top" | "middle" | "bottom";

function toExcelHorizontal(align: string | null): ExcelHorizontal {
  switch ((align || "").toLowerCase()) {
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "justify":
      return "justify";
    case "left":
    case "start":
    default:
      return "left";
  }
}

function toExcelVertical(align: string | null): ExcelVertical {
  switch ((align || "").toLowerCase()) {
    case "bottom":
    case "end":
      return "bottom";
    case "middle":
    case "center":
      return "middle";
    case "top":
    case "start":
    default:
      return "top";
  }
}

const THIN_GRAY_BORDER = {
  top: { style: "thin", color: { argb: "FF999999" } },
  left: { style: "thin", color: { argb: "FF999999" } },
  bottom: { style: "thin", color: { argb: "FF999999" } },
  right: { style: "thin", color: { argb: "FF999999" } },
} as const;

function columnLetter(index: number): string {
  let n = index;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Builds a real .xlsx workbook from the table payload produced by the editor.
 * Formatting intentionally mirrors the existing VS Code host implementation.
 */
export async function buildXlsxBuffer(
  payload: XlsxTablePayload,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");

  const totalCols = Math.max(payload.totalCols || 0, 1);
  const totalRows = Math.max(payload.totalRows || 0, 1);
  void totalCols;
  void totalRows;

  if (payload.columnWidths && payload.columnWidths.length) {
    payload.columnWidths.forEach((w, idx) => {
      if (typeof w === "number" && w > 0) {
        ws.getColumn(idx + 1).width = Math.max(4, Math.round(w / 7));
      }
    });
  }

  if (payload.rowHeights && payload.rowHeights.length) {
    payload.rowHeights.forEach((h, idx) => {
      if (typeof h === "number" && h > 0) {
        ws.getRow(idx + 1).height = Math.max(10, Math.round(h * 0.75));
      }
    });
  }

  for (const c of payload.cells) {
    const cell = ws.getCell(c.row + 1, c.col + 1);
    cell.value = c.text;
    cell.border = THIN_GRAY_BORDER;
    cell.alignment = {
      horizontal: toExcelHorizontal(c.alignment),
      vertical: toExcelVertical(c.verticalAlignment),
      wrapText: true,
    };
    if (c.isHeader) {
      cell.font = { bold: true };
    }
  }

  if (payload.merges) {
    for (const m of payload.merges) {
      if (m.bottom < m.top || m.right < m.left) continue;
      const start = `${columnLetter(m.left + 1)}${m.top + 1}`;
      const end = `${columnLetter(m.right + 1)}${m.bottom + 1}`;
      ws.mergeCells(`${start}:${end}`);
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
