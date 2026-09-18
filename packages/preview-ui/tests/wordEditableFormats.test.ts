import { describe, expect, it } from 'vitest';
import { isEditableWordFile } from '../src/word/editableFormats';

describe('editable word formats', () => {
  it('enables edit for docx/dotx only', () => {
    expect(isEditableWordFile('a.docx')).toBe(true);
    expect(isEditableWordFile('a.DOTX')).toBe(true);
    expect(isEditableWordFile('a.doc')).toBe(false);
    expect(isEditableWordFile('a.docm')).toBe(false);
  });
});
