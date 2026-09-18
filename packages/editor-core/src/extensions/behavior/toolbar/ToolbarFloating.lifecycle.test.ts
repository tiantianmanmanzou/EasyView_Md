/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';

import { schema } from '../../../editor/EditorSchema';
import { FloatingToolbar } from './ToolbarFloating';
import { LinkEditPopup } from './ToolbarLinkPopup';
import { createToolbarButtons } from './ToolbarButtons';

function createView(): EditorView {
  return {
    state: {
      selection: {
        empty: false,
        from: 1,
        to: 2,
      },
      schema,
    },
  } as unknown as EditorView;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('FloatingToolbar lifecycle', () => {
  it('removes every document and window pointer handler with the original references', () => {
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const documentRemove = vi.spyOn(document, 'removeEventListener');
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');

    const linkPopup = new LinkEditPopup();
    const toolbar = new FloatingToolbar(createToolbarButtons((view) => linkPopup.toggle(view)));
    toolbar.destroy();
    linkPopup.destroy();

    for (const eventName of ['mousedown', 'mouseup', 'mousemove']) {
      const addedHandler = documentAdd.mock.calls.find(([type]) => type === eventName)?.[1];
      expect(addedHandler).toBeDefined();
      expect(documentRemove).toHaveBeenCalledWith(eventName, addedHandler);
    }

    for (const eventName of ['pointerup', 'pointercancel', 'blur']) {
      const addedHandler = windowAdd.mock.calls.find(([type]) => type === eventName)?.[1];
      expect(addedHandler).toBeDefined();
      expect(windowRemove).toHaveBeenCalledWith(eventName, addedHandler);
    }
  });

  it('destroys the popover, clears the view and removes the toolbar idempotently', () => {
    const linkPopup = new LinkEditPopup();
    const toolbar = new FloatingToolbar(createToolbarButtons((view) => linkPopup.toggle(view)));
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    toolbar.attach(createView());

    (toolbar as unknown as {
      openTextColorPopover: (element: HTMLButtonElement) => void;
    }).openTextColorPopover(anchor);

    expect(document.querySelector('.easyview-text-color-popover')).not.toBeNull();
    expect(document.querySelector('.floating-toolbar')).not.toBeNull();

    toolbar.destroy();
    linkPopup.destroy();
    toolbar.destroy();

    expect(document.querySelector('.easyview-text-color-popover')).toBeNull();
    expect(document.querySelector('.floating-toolbar')).toBeNull();
    expect((toolbar as unknown as { view: EditorView | null }).view).toBeNull();
  });

  it('makes public operations safe after destruction and ignores later pointer events', () => {
    const linkPopup = new LinkEditPopup();
    const toolbar = new FloatingToolbar(createToolbarButtons((view) => linkPopup.toggle(view)));
    toolbar.destroy();

    expect(() => {
      toolbar.attach({} as EditorView);
      toolbar.update({} as EditorView);
      toolbar.forceHide();
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      window.dispatchEvent(new Event('pointerup'));
      window.dispatchEvent(new Event('pointercancel'));
      window.dispatchEvent(new Event('blur'));
    }).not.toThrow();
    linkPopup.destroy();
  });
});
