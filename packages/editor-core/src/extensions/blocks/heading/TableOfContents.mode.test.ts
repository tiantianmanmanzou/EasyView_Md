/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../../editor/EditorSchema';
import { TableOfContents } from './TableOfContents';

function createTocHarness(options?: { persistTableMode?: boolean }): { toc: TableOfContents; view: EditorView } {
  document.body.innerHTML = `
    <div id="editor-body">
      <div id="editor-scroll-area">
        <div id="editor" class="ProseMirror"></div>
      </div>
    </div>
  `;
  if (options?.persistTableMode) {
    window.localStorage.setItem('easyview-toc-source', 'table');
  }
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, schema.text('第一章')),
    schema.node('paragraph', null, schema.text('正文')),
    schema.node('heading', { level: 2 }, schema.text('小节')),
  ]);
  const mount = document.getElementById('editor')!;
  const view = new EditorView(mount, { state: EditorState.create({ schema, doc }) });
  const toc = new TableOfContents(view);
  return { toc, view };
}

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('TableOfContents outline source', () => {
  it('defaults to 全文目录', () => {
    const { toc, view } = createTocHarness();
    toc.open();
    const buttons = document.querySelectorAll<HTMLButtonElement>('.toc-table-mode-option');
    expect(buttons[0]?.textContent).toBe('全文目录');
    expect(buttons[0]?.classList.contains('active')).toBe(true);
    expect(buttons[1]?.classList.contains('active')).toBe(false);
    expect(document.querySelector('.toc-item-text')?.textContent).toBe('第一章');
    toc.destroy();
    view.destroy();
  });

  it('rebuilds heading items when switching back from 表格目录 after the cache was cleared', () => {
    const { toc, view } = createTocHarness({ persistTableMode: true });
    toc.open();
    toc.setFilePath('/tmp/cleared.md');
    expect(toc.getHeadings()).toEqual([]);

    const headingModeBtn = document.querySelectorAll<HTMLButtonElement>('.toc-table-mode-option')[0];
    headingModeBtn.click();

    expect(headingModeBtn.classList.contains('active')).toBe(true);
    const labels = [...document.querySelectorAll('.toc-item-text')].map((el) => el.textContent);
    expect(labels).toEqual(['第一章', '小节']);
    expect(document.querySelector('.toc-empty')).toBeNull();
    toc.destroy();
    view.destroy();
  });

  it('refreshes the heading cache from update() even while 表格目录 is showing', () => {
    const { toc, view } = createTocHarness({ persistTableMode: true });
    toc.open();
    toc.setFilePath('/tmp/pending.md');
    expect(toc.getHeadings()).toEqual([]);

    toc.update(view);
    expect(toc.getHeadings().map((heading) => heading.text)).toEqual(['第一章', '小节']);

    document.querySelectorAll<HTMLButtonElement>('.toc-table-mode-option')[0].click();
    expect(document.querySelector('.toc-item-text')?.textContent).toBe('第一章');
    toc.destroy();
    view.destroy();
  });
});
