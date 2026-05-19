/**
 * Heading Picker Popup
 *
 * Shows a popup to select a heading for inserting an anchor link.
 * Extracted from SlashMenu.ts.
 */

import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../../editor/EditorSchema';
import type { HeadingAnchor } from '../../blocks/heading/AnchorPlugin';

export function showHeadingPicker(
  view: EditorView,
  from: number,
  to: number,
  anchors: HeadingAnchor[]
) {
  const overlay = document.createElement('div');
  overlay.className = 'heading-picker-overlay';

  const popup = document.createElement('div');
  popup.className = 'heading-picker';

  let selectedIndex = 0;

  function render() {
    popup.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'heading-picker-title';
    title.textContent = 'Select heading';
    popup.appendChild(title);

    anchors.forEach((anchor, i) => {
      const item = document.createElement('div');
      item.className = `heading-picker-item${i === selectedIndex ? ' selected' : ''}`;
      const indent = '  '.repeat(anchor.level - 1);
      const prefix = '#'.repeat(anchor.level);
      item.textContent = `${indent}${prefix} ${anchor.text}`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        insertAnchorLink(anchor);
      });
      item.addEventListener('mouseenter', () => {
        selectedIndex = i;
        render();
      });
      popup.appendChild(item);
    });
  }

  function insertAnchorLink(anchor: HeadingAnchor) {
    cleanup();
    const linkMark = schema.marks.link.create({ href: `#${anchor.id}` });
    const linkText = schema.text(anchor.text, [linkMark]);
    const node = schema.nodes.paragraph.create(null, linkText);
    const tr = view.state.tr.replaceWith(from, to, node);
    const newPos = from + 1 + anchor.text.length;
    tr.setSelection(TextSelection.create(tr.doc, newPos));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }

  function handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % anchors.length;
        render();
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + anchors.length) % anchors.length;
        render();
        break;
      case 'Enter':
        e.preventDefault();
        insertAnchorLink(anchors[selectedIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        cleanup();
        view.focus();
        break;
    }
  }

  function cleanup() {
    overlay.remove();
    popup.remove();
    document.removeEventListener('keydown', handleKeyDown, true);
  }

  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    cleanup();
    view.focus();
  });

  document.addEventListener('keydown', handleKeyDown, true);
  render();

  // Position popup near the cursor
  try {
    const coords = view.coordsAtPos(from);
    let left = coords.left;
    let top = coords.bottom + 6;
    if (left + 300 > window.innerWidth) left = window.innerWidth - 308;
    if (top + 300 > window.innerHeight) top = coords.top - 306;
    popup.style.left = `${Math.max(8, left)}px`;
    popup.style.top = `${top}px`;
    popup.style.position = 'fixed';
  } catch { /* position failed */ }

  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}
