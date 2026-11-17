const OVERLAY_SELECTORS = [
  '.easyview-terminal-modal.visible',
  '.desktop-command-palette.is-open',
  '.folder-icon-picker-overlay',
  '.context-menu.visible',
  'dialog[open]',
  '.dock-overlay',
];

/** The native browser view paints above the renderer, so any covering overlay must hide it. */
export function isBrowserSurfaceObscured(doc: Document): boolean {
  if (doc.body.classList.contains('desktop-welcome-active')) return true;
  return OVERLAY_SELECTORS.some((selector) => doc.querySelector(selector));
}
