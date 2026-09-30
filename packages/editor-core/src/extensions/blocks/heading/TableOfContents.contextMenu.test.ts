/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '../../../editor/EditorSchema';
import { TableOfContents } from './TableOfContents';

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
});

it('uses the right-clicked heading for all three existing path actions', () => {
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>'; 
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, schema.text('Root')),
    schema.node('heading', { level: 2 }, schema.text('Target')),
  ]);
  const view = new EditorView(document.getElementById('editor')!, {
    state: EditorState.create({ schema, doc }),
  });
  const onCopyOutlinePath = vi.fn();
  const onSendHeadingToChat = vi.fn();
  const onInsertIntoITerm = vi.fn();
  const toc = new TableOfContents(view, {
    onCopyOutlinePath, onSendHeadingToChat, onInsertIntoITerm,
  });
  try {
    toc.open();
    const target = [...document.querySelectorAll<HTMLElement>('.toc-item')]
      .find((item) => item.querySelector('.toc-item-text')?.textContent === 'Target')!;
    const targetPos = Number(target.dataset.pos);
    const selectMenuAction = (label: string): void => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      expect(target.dispatchEvent(event)).toBe(false);
      const buttons = [...document.querySelectorAll<HTMLElement>('.toc-context-menu .context-menu-item')];
      expect(buttons.map((button) => button.textContent)).toEqual([
        'Copy outline path to clipboard', 'Copy outline path to Cursor chat', 'Copy outline path to iTerm2',
      ]);
      expect(buttons.map((button) => button.querySelector('svg')?.getAttribute('viewBox'))).toEqual([
        '0 0 24 24', '600 300 400 400', '0 0 24 24',
      ]);
      expect(buttons.every((button) => button.querySelector('.toc-context-menu-icon')?.getAttribute('aria-hidden') === 'true')).toBe(true);
      expect(buttons.every((button) => button.tagName === 'DIV')).toBe(true);
      buttons.find((button) => button.textContent === label)!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      expect(document.querySelector('.toc-context-menu')).toBeNull();
    };
    selectMenuAction('Copy outline path to clipboard');
    selectMenuAction('Copy outline path to Cursor chat');
    selectMenuAction('Copy outline path to iTerm2');
    expect(onCopyOutlinePath).toHaveBeenCalledExactlyOnceWith(targetPos);
    expect(onSendHeadingToChat).toHaveBeenCalledExactlyOnceWith(targetPos);
    expect(onInsertIntoITerm).toHaveBeenCalledExactlyOnceWith(targetPos);
  } finally {
    toc.destroy();
    view.destroy();
  }
});
