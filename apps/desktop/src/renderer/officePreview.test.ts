import { describe, expect, it } from 'vitest';
import { isAgentEditablePreview, previewPathMatches } from './officePreview';

describe('office preview helpers', () => {
  it('marks xlsx/docx/pptx previews as Agent-editable', () => {
    expect(isAgentEditablePreview('data/Sales.XLSX')).toBe(true);
    expect(isAgentEditablePreview('a.docx')).toBe(true);
    expect(isAgentEditablePreview('a.DOTX')).toBe(true);
    expect(isAgentEditablePreview('deck.PPTX')).toBe(true);
    expect(isAgentEditablePreview('theme.potx')).toBe(true);
    expect(isAgentEditablePreview('a.xls')).toBe(false);
    expect(isAgentEditablePreview('a.pdf')).toBe(false);
  });

  it('matches absolute host paths to workspace-relative tab paths', () => {
    expect(previewPathMatches('/ws/data/book.xlsx', 'data/book.xlsx')).toBe(true);
    expect(previewPathMatches('C:\\ws\\data\\book.xlsx', 'data/book.xlsx')).toBe(true);
    expect(previewPathMatches('/ws/data/xbook.xlsx', 'book.xlsx')).toBe(false);
    expect(previewPathMatches('/ws/book.xlsx', '')).toBe(false);
  });
});
