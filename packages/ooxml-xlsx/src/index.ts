/**
 * xlsx adapter — scaffold. P1 will replace ExcelJS read/write paths.
 */
export const OOXML_XLSX_KIND = 'xlsx' as const;

export function createXlsxAdapterStub(): {
  kind: 'xlsx';
  note: string;
} {
  return {
    kind: OOXML_XLSX_KIND,
    note: 'Scaffold only. Implement query/apply against @easyview/ooxml-core in P1.',
  };
}
