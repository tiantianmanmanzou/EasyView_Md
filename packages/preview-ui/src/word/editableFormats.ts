/** Word OOXML suffixes that open as the editable document route. */
export const EDITABLE_WORD_SUFFIXES = ['.docx', '.dotx'] as const;

export function isEditableWordFile(fileName: string): boolean {
  const lower = fileName.trim().toLocaleLowerCase();
  return EDITABLE_WORD_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
