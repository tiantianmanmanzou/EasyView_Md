/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { EASYVIEW_MONOSPACE_FONT_FAMILY } from '@easyview/contracts';
import { DESKTOP_DOCUMENT_FONT_FAMILIES, isDesktopAppearanceCommand } from '../contracts';
import { applyDocumentFont, readDocumentFont, saveDocumentFont } from './documentFont';

afterEach(() => {
  localStorage.clear();
  document.body.removeAttribute('style');
});

describe('Desktop document font', () => {
  it('defaults to the VS Code extension monospace font', () => {
    expect(readDocumentFont(localStorage)).toBe('sarasa');
    applyDocumentFont(document.body, readDocumentFont(localStorage));
    expect(document.body.style.getPropertyValue('--easyview-document-font-family')).toBe(EASYVIEW_MONOSPACE_FONT_FAMILY);
  });

  it('falls back to the default for unknown stored values', () => {
    localStorage.setItem('easyview.documentFont', 'comicSans');
    expect(readDocumentFont(localStorage)).toBe('sarasa');
  });

  it('persists and applies the chosen font', () => {
    saveDocumentFont(localStorage, 'pingFang');
    const font = readDocumentFont(localStorage);
    applyDocumentFont(document.body, font);
    expect(font).toBe('pingFang');
    expect(document.body.style.getPropertyValue('--easyview-document-font-family')).toBe(DESKTOP_DOCUMENT_FONT_FAMILIES.pingFang);
    expect(document.body.style.getPropertyValue('--vscode-font-family')).toBe(DESKTOP_DOCUMENT_FONT_FAMILIES.pingFang);
    expect(document.body.style.getPropertyValue('--vscode-editor-font-family')).toBe(EASYVIEW_MONOSPACE_FONT_FAMILY);
  });

  it('uses a chosen monospace font for code areas too', () => {
    applyDocumentFont(document.body, 'menlo');
    expect(document.body.style.getPropertyValue('--vscode-editor-font-family')).toBe(DESKTOP_DOCUMENT_FONT_FAMILIES.menlo);
  });

  it('routes font menu commands as appearance commands', () => {
    expect(isDesktopAppearanceCommand('setDocumentFont:menlo')).toBe(true);
    expect(isDesktopAppearanceCommand('setDocumentFontX')).toBe(false);
  });
});
