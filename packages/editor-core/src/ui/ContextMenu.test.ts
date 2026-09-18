/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import type { MarkdownParser } from 'prosemirror-markdown';

import { initContextMenu } from './ContextMenu';

function createEditorElement(): HTMLElement {
  const editorElement = document.createElement('div');
  document.body.appendChild(editorElement);
  return editorElement;
}

function createView(): EditorView {
  return {} as EditorView;
}

function createPasteParser(): MarkdownParser {
  return {} as MarkdownParser;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ContextMenu lifecycle', () => {
  it('returns an idempotent cleanup function that removes listeners and menu DOM', () => {
    const editorElement = createEditorElement();
    const getView = vi.fn(() => createView());
    const getPasteParser = vi.fn(() => createPasteParser());
    const cleanup = initContextMenu(editorElement, getView, getPasteParser);

    editorElement.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 12,
      clientY: 24,
    }));

    expect(document.querySelector('.context-menu')).not.toBeNull();
    expect(getView).toHaveBeenCalledTimes(1);
    expect(getPasteParser).toHaveBeenCalledTimes(1);

    cleanup();
    cleanup();

    expect(document.querySelector('.context-menu')).toBeNull();

    editorElement.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 12,
      clientY: 24,
    }));
    expect(getView).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.context-menu')).toBeNull();
  });

  it('removes document-level hide handlers during cleanup', () => {
    const editorElement = createEditorElement();
    const cleanup = initContextMenu(
      editorElement,
      () => createView(),
      () => createPasteParser(),
    );

    editorElement.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 12,
      clientY: 24,
    }));
    const menu = document.querySelector<HTMLElement>('.context-menu');
    expect(menu).not.toBeNull();
    expect(menu!.classList.contains('visible')).toBe(true);

    cleanup();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(document.querySelector('.context-menu')).toBeNull();
  });
});
