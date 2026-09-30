// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ChangeViewController } from './ChangeViewController';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('embeds deleted source above editable new lines and restores the original editor', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = '# 1.1 New title\n1. new item\nkept\n';
  const postEdit = vi.fn();
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => '# Old title\nold\nkept\n', postEdit, stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  expect(editorElement.style.display).toBe('none');
  expect(scrollArea.classList.contains('easyview-change-scroll-host')).toBe(true);
  expect(document.querySelector('.easyview-change-deletion-marker')?.textContent).toBe('−');
  expect([...document.querySelectorAll('.easyview-change-deletion-text')].map((el) => el.textContent).join('\n')).toContain('old');
  expect([...document.querySelectorAll('.easyview-change-deletion-text')].every((el) => !el.textContent?.startsWith('−'))).toBe(true);
  expect([...document.querySelectorAll('.cm-line.easyview-change-modified')].map((el) => el.textContent).join('\n')).toContain('new');
  expect(document.querySelector('.easyview-change-numbering')?.textContent).toBe('1.1');
  expect(document.querySelector('.easyview-change-heading-text')?.textContent).toContain('New title');
  expect(document.querySelector('.easyview-change-heading-text')?.textContent).not.toContain('1.1');
  expect(document.querySelector('.easyview-change-heading-prefix')).toBeTruthy();
  expect(document.querySelector('.cm-change-list-marker')?.textContent).toBe('1.');
  expect(document.querySelector('.easyview-change-kind-gutter')).toBeTruthy();
  expect(document.querySelector('.easyview-change-kind-bar-modified, .easyview-change-kind-bar-added')).toBeTruthy();
  expect(document.querySelector('.easyview-change-scrollbar')).toBeTruthy();
  expect(document.querySelector('.easyview-change-scrollbar-thumb')).toBeTruthy();
  const cm = document.querySelector('.easyview-change-view .cm-editor') as HTMLElement;
  expect(cm).toBeTruthy();
  expect(cm.contains(document.activeElement)).toBe(true);
  expect(document.querySelector('.easyview-change-overview > .deleted')).toBeTruthy();
  expect(document.querySelector('.easyview-change-overview > .added')).toBeTruthy();
  const cmEditor = document.querySelector('.easyview-change-view .cm-content')!;
  expect(cmEditor.classList.contains('cm-lineWrapping')).toBe(false);
  cmEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', altKey: true, bubbles: true, cancelable: true }));
  expect(cmEditor.classList.contains('cm-lineWrapping')).toBe(true);
  const editorView = (cm as any).cmView;
  expect(editorView).toBeUndefined();
  controller.close();
  expect(document.querySelector('.easyview-change-view')).toBeNull();
  expect(scrollArea.classList.contains('easyview-change-scroll-host')).toBe(false);
  expect(editorElement.style.display).toBe('');
});

it('widens the overlay scrollbar on hover and keeps it outside the scrollport', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = '# New\n';
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => '# Old\n', postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  const rail = document.querySelector('.easyview-change-scrollbar');
  expect(rail).toBeTruthy();
  expect(document.querySelector('.easyview-change-view')?.contains(rail)).toBe(false);
  expect(scrollArea.contains(rail)).toBe(false);
  expect(rail?.parentElement).toBe(document.body);
  expect(rail?.classList.contains('is-expanded')).toBe(false);
  rail!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
  expect(rail?.classList.contains('is-expanded')).toBe(true);
  expect(document.querySelector('.easyview-change-scrollbar-thumb')).toBeTruthy();
  expect(document.querySelector('.easyview-change-overview')).toBeTruthy();
  controller.close();
  expect(document.querySelector('.easyview-change-scrollbar')).toBeNull();
});

it('forwards wheel and trackpad scrolling from the overlay rail to the host', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 800 });
  scrollArea.scrollTop = 0;
  let content = '# New\n';
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => '# Old\n', postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  const rail = document.querySelector('.easyview-change-scrollbar')!;
  const event = new WheelEvent('wheel', { deltaY: 40, deltaMode: 0, bubbles: true, cancelable: true });
  rail.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(scrollArea.scrollTop).toBe(40);
  controller.close();
});

it('scrolls the host pane to the matching change-view heading', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  scrollArea.scrollTo = vi.fn();
  let content = '# 1.1 New title\n\nbody\n\n## Nested heading\n\nmore\n';
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => '# Old title\n\nbody\n\n## Nested heading\n\nmore\n',
    postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  controller.revealHeading(1, '1.1 New title');
  expect(scrollArea.scrollTo).toHaveBeenCalled();
  (scrollArea.scrollTo as ReturnType<typeof vi.fn>).mockClear();
  controller.revealHeading(2, 'Nested heading');
  expect(scrollArea.scrollTo).toHaveBeenCalled();
  controller.close();
});

it('floats hunk actions over the line numbers only after selecting a change block', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = 'one\nchanged\nthree\nfour\n';
  const stageHunk = vi.fn();
  const postEdit = vi.fn();
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => 'one\ntwo\nthree\n',
    postEdit, stageHunk, onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  expect(document.querySelectorAll('.easyview-change-hunk-actions')).toHaveLength(0);
  expect(document.querySelector('.easyview-change-hunk-gutter')).toBeNull();

  document.querySelector('.cm-line.easyview-change-modified')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(document.querySelectorAll('.easyview-change-hunk-actions')).toHaveLength(1);
  expect(document.querySelector('.easyview-change-view > .easyview-change-hunk-actions')).toBeTruthy();

  document.querySelector('.easyview-change-hunk-actions [data-hunk-action="revert"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(content).toBe('one\ntwo\nthree\nfour\n');
  expect(postEdit).toHaveBeenCalledWith('one\ntwo\nthree\nfour\n');

  document.querySelector('.cm-line.easyview-change-added')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.querySelector('.easyview-change-hunk-actions [data-hunk-action="stage"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(stageHunk).toHaveBeenCalledWith('one\ntwo\nthree\nfour\n');
  controller.close();
});

it('keeps the diff fill on pipe table rows instead of the table-row background', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = '| 打开 | 点击新增且有新增权限 | 展示可编辑字段 |\n';
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => '| 打开 | 点击新增 | 展示字段 |\n',
    postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  const line = document.querySelector('.cm-line.easyview-change-modified, .cm-line.easyview-change-added') as HTMLElement;
  expect(line).toBeTruthy();
  expect(line.textContent).toContain('点击新增且有新增权限');
  expect(line.style.background).not.toBe('rgba(255,255,255,0.03)');
  expect(line.getAttribute('style') ?? '').not.toContain('rgba(255,255,255,0.03)');
  expect(document.querySelector('.easyview-change-text-added')?.textContent).toContain('权限');
  controller.close();
});

it('does not mark character inserts on added-only lines', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = 'kept\nbrand new line\n';
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => 'kept\n',
    postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  expect(document.querySelector('.cm-line.easyview-change-added')?.textContent).toContain('brand new line');
  expect(document.querySelector('.easyview-change-text-added')).toBeNull();
  expect(document.querySelector('.easyview-change-deletion')).toBeNull();
  controller.close();
});

it('wraps replaced fragments in the deleted source when old text remains', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = 'hello changed\n';
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => 'hello two\n',
    postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor: () => ({ line: 1, offsetFromTop: 0 }), revealSourceAnchor: vi.fn(),
  });
  controller.open();
  expect(document.querySelector('.easyview-change-text-added')?.textContent).toBe('changed');
  expect(document.querySelector('.easyview-change-text-removed')?.textContent).toBe('two');
  controller.close();
});

it('restores the visible source line when leaving change view', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.body.innerHTML = '<div id="editor-scroll-area"><div id="editor">Rendered</div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  const editorElement = document.getElementById('editor')!;
  let content = 'one\ntwo\nthree\nfour\nfive\n';
  const getVisibleSourceAnchor = vi.fn(() => ({ line: 4, offsetFromTop: 16 }));
  const revealSourceAnchor = vi.fn();
  const controller = new ChangeViewController({
    scrollArea, editorElement, currentContent: () => content,
    setContent(next) { content = next; },
    getBaseContent: () => 'one\ntwo\nthree\nfour\nfive\n',
    postEdit: vi.fn(), stageHunk: vi.fn(), onStateChange: vi.fn(),
    getVisibleSourceAnchor, revealSourceAnchor,
  });
  controller.open();
  expect(getVisibleSourceAnchor).toHaveBeenCalled();
  controller.close();
  expect(revealSourceAnchor).toHaveBeenCalled();
  expect(revealSourceAnchor.mock.calls[0][0].line).toBeGreaterThanOrEqual(1);
});

it('lets the Change View host scroll horizontally when wrapping is off', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../webview.css'), 'utf8');
  expect(css).toContain('#editor-scroll-area.easyview-change-scroll-host');
  expect(css).toContain('overflow-x: auto !important');
  expect(css).toContain('scrollbar-width: none !important');
  expect(css).toMatch(/\.easyview-change-view \.cm-scroller \{[\s\S]*?overflow: visible !important;/);
  expect(css).not.toMatch(/\.easyview-change-view \.cm-scroller \{[\s\S]*?overflow: hidden !important;/);
  expect(css).toContain('width: max-content');
  expect(css).not.toMatch(/\.easyview-change-deletion \{\s*--easyview-change-gutter-width: 0px/);
  expect(css).toContain('easyview-change-kind-gutter');
  expect(css).toMatch(/\.easyview-change-view \.cm-line\.easyview-change-added[\s\S]*?border-left: none !important;/);
  const scrollbarRule = css.match(/\.easyview-change-scrollbar \{[^}]+\}/)?.[0] ?? '';
  expect(scrollbarRule).toContain('position: fixed');
  expect(scrollbarRule).not.toContain('float:');
  expect(scrollbarRule).not.toContain('position: sticky');
  const expandedRule = css.match(/\.easyview-change-scrollbar\.is-expanded,\n\.easyview-change-scrollbar:hover \{[^}]+\}/)?.[0] ?? '';
  expect(expandedRule).toContain('width: 30px');
  expect(expandedRule).not.toContain('background:');
  const thumbRule = css.match(/\.easyview-change-scrollbar-thumb \{[^}]+\}/)?.[0] ?? '';
  expect(thumbRule).toContain('left: 0');
  expect(thumbRule).toContain('right: 0');
  expect(thumbRule).toContain('border-radius: 2px');
  expect(css).toContain('easyview-change-text-added');
  expect(css).toContain('easyview-change-text-removed');
  expect(css).toMatch(/\.easyview-change-view \.easyview-change-text-added \{[\s\S]*?62%/);
  expect(css).toMatch(/\.easyview-change-text-removed \{[\s\S]*?62%/);
});
