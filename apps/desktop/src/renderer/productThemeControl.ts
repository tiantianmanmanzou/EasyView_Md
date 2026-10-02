import { applyEditorAppearance, type EditorAppearanceState } from '@easyview/editor-core';

/**
 * Render product appearance on the app shell so previews and every editor
 * inherit the same palette, even when no Markdown document is open.
 */
export function applyDesktopProductAppearance(state: Readonly<EditorAppearanceState>, document: Document): void {
  applyEditorAppearance(document.body, state);
  document.documentElement.dataset.easyviewTheme = state.mode;
  document.documentElement.dataset.theme = state.mode === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('vscode-dark', state.mode === 'dark');
  document.body.classList.toggle('vscode-light', state.mode !== 'dark');
  const root = document.getElementById('desktop-root');
  if (root) root.dataset.easyviewTheme = state.mode;
  const detail = { mode: state.mode, isDark: state.mode === 'dark', depth: state.depth };
  document.defaultView?.dispatchEvent(new CustomEvent('inlinemd:themeChanged', { detail }));
  document.defaultView?.dispatchEvent(new CustomEvent('easyview:productThemeChanged', { detail }));
}
