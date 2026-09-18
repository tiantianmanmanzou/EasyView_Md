/** Spreadsheet suffixes that open as the editable document route. Others stay on UniversalFilePreview. */
export const EDITABLE_SPREADSHEET_SUFFIXES = ['.xlsx', '.xlsm'] as const;

export function isEditableSpreadsheetFile(fileName: string): boolean {
  const lower = fileName.trim().toLocaleLowerCase();
  return EDITABLE_SPREADSHEET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
