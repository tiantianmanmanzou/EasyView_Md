import { DESKTOP_DEFAULT_DOCUMENT_FONT, DESKTOP_DOCUMENT_FONT_FAMILIES, DESKTOP_DOCUMENT_FONTS, type DesktopDocumentFont } from '../contracts';

type FontStorage = Pick<Storage, 'getItem' | 'setItem'>;
const DOCUMENT_FONT_STORAGE_KEY = 'easyview.documentFont';

export function readDocumentFont(storage: FontStorage): DesktopDocumentFont {
  try {
    const stored = storage.getItem(DOCUMENT_FONT_STORAGE_KEY) as DesktopDocumentFont | null;
    if (stored && DESKTOP_DOCUMENT_FONTS.includes(stored)) return stored;
  } catch {
    // Storage can be unavailable in restricted contexts.
  }
  return DESKTOP_DEFAULT_DOCUMENT_FONT;
}

export function saveDocumentFont(storage: FontStorage, font: DesktopDocumentFont): void {
  try {
    storage.setItem(DOCUMENT_FONT_STORAGE_KEY, font);
  } catch {
    // Storage can be unavailable in restricted contexts.
  }
}

const MONOSPACE_FONTS: readonly DesktopDocumentFont[] = ['sarasa', 'sfMono', 'menlo'];

/** Applies the font to the whole app shell; code areas keep a monospace font when a proportional one is chosen. */
export function applyDocumentFont(root: HTMLElement, font: DesktopDocumentFont): void {
  const family = DESKTOP_DOCUMENT_FONT_FAMILIES[font];
  root.style.setProperty('--easyview-document-font-family', family);
  root.style.setProperty('--vscode-font-family', family);
  root.style.setProperty('--vscode-editor-font-family', MONOSPACE_FONTS.includes(font) ? family : DESKTOP_DOCUMENT_FONT_FAMILIES[DESKTOP_DEFAULT_DOCUMENT_FONT]);
}
