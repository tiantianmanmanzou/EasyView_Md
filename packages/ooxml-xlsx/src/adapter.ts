import type { OpcPackage } from '@easyview/ooxml-core/opc';
import type { DocumentOp, FormatAdapter, Locator } from '@easyview/ooxml-core/ops';
import { applySheetOp, type XlsxSheetOp } from './ops';
import { XlsxWorkbook } from './workbook';

const workbookCache = new WeakMap<OpcPackage, XlsxWorkbook>();

async function workbookFor(pkg: OpcPackage): Promise<XlsxWorkbook> {
  const cached = workbookCache.get(pkg);
  if (cached) return cached;
  const workbook = await XlsxWorkbook.open(pkg);
  workbookCache.set(pkg, workbook);
  return workbook;
}

function opFromDocument(op: DocumentOp): XlsxSheetOp {
  const args = (op.args ?? {}) as Record<string, unknown>;
  if (op.op === 'sheetOp') return args as unknown as XlsxSheetOp;
  // Allow direct passthrough of sheet op name for convenience.
  return { op: op.op, ...args, sheet: args.sheet ?? op.target.key } as XlsxSheetOp;
}

export function createXlsxAdapter(): FormatAdapter {
  return {
    kind: 'xlsx',
    async summary(pkg) {
      const workbook = await workbookFor(pkg);
      return {
        kind: 'xlsx',
        sheets: workbook.sheets.map((sheet) => ({ name: sheet.name, path: sheet.path })),
        parts: pkg.listParts(),
      };
    },
    async read(pkg, locator: Locator) {
      const workbook = await workbookFor(pkg);
      if (locator.key?.includes('!')) {
        const [sheet, ref] = locator.key.split('!');
        return { sheet, ref, value: await workbook.getCell(sheet, ref) };
      }
      if (locator.key) {
        return workbook.summarizeSheet(locator.key, 20, 50);
      }
      return {
        sheets: await Promise.all(
          workbook.sheets.map((sheet) => workbook.summarizeSheet(sheet.name, 20, 50)),
        ),
      };
    },
    async apply(pkg, ops: DocumentOp[]) {
      const workbook = await workbookFor(pkg);
      for (const op of ops) {
        await applySheetOp(workbook, opFromDocument(op));
      }
      return workbook.flush();
    },
  };
}

export async function getXlsxWorkbook(pkg: OpcPackage): Promise<XlsxWorkbook> {
  return workbookFor(pkg);
}
