/**
 * Image URL Popup
 *
 * Shows a popup to enter an image URL for insertion.
 * Extracted from SlashMenu.ts.
 */

import type { EditorView } from 'prosemirror-view';
import { schema } from '../../../editor/EditorSchema';

export function showImageUrlPopup(view: EditorView, from: number, to: number) {
  const overlay = document.createElement('div');
  overlay.className = 'heading-picker-overlay';

  const popup = document.createElement('div');
  popup.className = 'image-url-popup';
  popup.style.position = 'fixed';

  const input = document.createElement('input');
  input.className = 'link-edit-input';
  input.type = 'url';
  input.placeholder = 'Enter image URL...';
  input.spellcheck = false;

  const submitBtn = document.createElement('button');
  submitBtn.className = 'link-edit-btn';
  submitBtn.title = 'Insert';
  submitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function insertImage() {
    const url = input.value.trim();
    if (!url) return;
    cleanup();
    const imgNode = schema.nodes.paragraph.create(null,
      schema.nodes.image.create({ src: url, alt: '' })
    );
    const tr = view.state.tr.replaceWith(from, to, imgNode);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  function cleanup() {
    overlay.remove();
    popup.remove();
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); insertImage(); }
    if (e.key === 'Escape') { e.preventDefault(); cleanup(); view.focus(); }
  });

  submitBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    insertImage();
  });

  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    cleanup();
    view.focus();
  });

  popup.appendChild(input);
  popup.appendChild(submitBtn);

  // Position near cursor
  try {
    const coords = view.coordsAtPos(from);
    let left = coords.left;
    let top = coords.bottom + 6;
    if (left + 320 > window.innerWidth) left = window.innerWidth - 328;
    if (top + 50 > window.innerHeight) top = coords.top - 56;
    popup.style.left = `${Math.max(8, left)}px`;
    popup.style.top = `${top}px`;
  } catch { /* position failed */ }

  document.body.appendChild(overlay);
  document.body.appendChild(popup);
  requestAnimationFrame(() => input.focus());
}
