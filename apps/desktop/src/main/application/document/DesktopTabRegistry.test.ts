import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesktopTabRegistry } from './DesktopTabRegistry';

// The app stores platform-absolute paths (path.resolve), e.g. D:\tmp\a.md on Windows.
const p = (filePath: string): string => path.resolve(filePath);

describe('DesktopTabRegistry', () => {
  it('deduplicates file tabs and activates the existing tab', () => {
    const registry = new DesktopTabRegistry();
    const editor = registry.openEditor(p('/tmp/a.md'), 'a.md', 'editor-a');
    registry.openPreview('docs/readme.pdf', 'readme.pdf', 'pdf', 'preview-a');
    const duplicate = registry.openEditor(p('/tmp/a.md'), 'a.md', 'editor-b');

    expect(duplicate.id).toBe(editor.id);
    expect(registry.snapshot()).toMatchObject({ activeTabId: 'editor-a' });
    expect(registry.snapshot().tabs).toHaveLength(2);
  });

  it('keeps dirty state isolated and selects an adjacent tab on close', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.openEditor(p('/tmp/b.md'), 'b.md', 'b');
    registry.openPreview('c.pdf', 'c.pdf', 'pdf', 'c');
    registry.setEditorDirty('a', true);
    registry.activate('b');

    const active = registry.close('b');
    expect(active?.id).toBe('c');
    expect(registry.get('a')).toMatchObject({ kind: 'editor', dirty: true });
  });

  it('opens a browser tab beside documents and persists its address', () => {
    const registry = new DesktopTabRegistry();
    const browser = registry.openBrowser({ id: 'browser-1', url: 'https://example.com', fileName: 'example.com' });
    registry.openBrowser({ url: 'https://example.com', fileName: 'again' });
    expect(registry.snapshot().tabs.filter((tab) => tab.kind === 'browser')).toHaveLength(1);
    expect(registry.active()?.id).toBe(browser.id);
    registry.updateBrowser(browser.id, { title: 'Example', fileName: 'Example', loading: false, canGoBack: true });
    expect(registry.get(browser.id)).toMatchObject({ fileName: 'Example', canGoBack: true, loading: false });
    expect(registry.persisted()).toContainEqual({ id: 'browser-1', kind: 'browser', url: 'https://example.com' });
    const renamed = registry.renameBrowser('page.html', 'moved.html', 'moved.html', 'file:///tmp/moved.html');
    expect(renamed).toEqual([]);
    registry.openBrowser({ id: 'local', url: 'file:///tmp/page.html', fileName: 'page.html', relativePath: 'page.html' });
    expect(registry.renameBrowser('page.html', 'moved.html', 'moved.html', 'file:///tmp/moved.html')).toEqual(['local']);
    expect(registry.get('local')).toMatchObject({ relativePath: 'moved.html', url: 'file:///tmp/moved.html' });
  });

  it('persists file identity without renderer-only state', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.setEditorDirty('a', true);
    registry.openPreview('docs/a.pdf', 'a.pdf', 'pdf', 'p');

    expect(registry.persisted()).toEqual([
      { id: 'a', kind: 'editor', filePath: p('/tmp/a.md') },
      { id: 'p', kind: 'preview', relativePath: 'docs/a.pdf' },
    ]);
  });

  it('keeps the document identity when a file path changes', () => {
    const registry = new DesktopTabRegistry('window-a');
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.setEditorDocumentId('a', 'document-a');
    registry.renameEditor('a', p('/tmp/renamed.md'), 'renamed.md');

    expect(registry.get('a')).toMatchObject({
      filePath: p('/tmp/renamed.md'),
      documentId: 'document-a',
    });
  });

  it('moves pinned tabs to the front and unpinned tabs right after them', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.openEditor(p('/tmp/b.md'), 'b.md', 'b');
    registry.openPreview('c.pdf', 'c.pdf', 'pdf', 'c');
    registry.openEditor(p('/tmp/d.md'), 'd.md', 'd');
    const order = (): string[] => registry.snapshot().tabs.map((tab) => `${tab.id}${tab.pinned ? '*' : ''}`);

    registry.setPinned('c', true);
    registry.setPinned('d', true);
    expect(order()).toEqual(['c*', 'd*', 'a', 'b']);

    registry.setPinned('c', false);
    expect(order()).toEqual(['d*', 'c', 'a', 'b']);
    expect(registry.persisted()).toEqual([
      { id: 'd', kind: 'editor', filePath: p('/tmp/d.md'), pinned: true },
      { id: 'c', kind: 'preview', relativePath: 'c.pdf' },
      { id: 'a', kind: 'editor', filePath: p('/tmp/a.md') },
      { id: 'b', kind: 'editor', filePath: p('/tmp/b.md') },
    ]);
    registry.openEditor(p('/tmp/e.md'), 'e.md', 'e');
    expect(order()).toEqual(['d*', 'c', 'a', 'b', 'e']);
  });

  it('keeps pinned tabs through close-others and close-all', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.openEditor(p('/tmp/b.md'), 'b.md', 'b');
    registry.openEditor(p('/tmp/c.md'), 'c.md', 'c');
    registry.setPinned('a', true);

    expect(registry.closeOthers('c').map((tab) => tab.id)).toEqual(['b']);
    expect(registry.snapshot()).toMatchObject({ activeTabId: 'c' });
    expect(registry.closeAllInGroup('c').map((tab) => tab.id)).toEqual(['c']);
    expect(registry.snapshot()).toMatchObject({ activeTabId: 'a' });
    expect(registry.snapshot().tabs.map((tab) => tab.id)).toEqual(['a']);
  });

  it('does not pin history tabs or carry pins into split copies', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.setPinned('a', true);
    const split = registry.split('a', 'right', 'group-2', 'a-split');

    expect(split?.tabs[0].pinned).toBeUndefined();
    expect(registry.setPinned('missing', true)).toBeNull();
  });
});

describe('DesktopTabRegistry editor groups', () => {
  it('keeps close-others and close-all scoped to the tab group', () => {
    const registry = new DesktopTabRegistry('window-a');
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.openEditor(p('/tmp/b.md'), 'b.md', 'b');
    registry.split('a', 'right', 'group-b', 'a-split');
    registry.openEditor(p('/tmp/c.md'), 'c.md', 'c', 'group-b');

    expect(registry.closeOthers('a-split').map((tab) => tab.id)).toEqual(['c']);
    expect(registry.snapshot().groups.find((group) => group.id === 'group-1')?.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
    expect(registry.closeAllInGroup('a-split').map((tab) => tab.id)).toEqual(['a-split']);
    expect(registry.snapshot().groups).toHaveLength(1);
  });

  it('shares dirty identity across split views and produces a real layout tree', () => {
    const registry = new DesktopTabRegistry('window-a');
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a');
    registry.split('a', 'down', 'group-b', 'a-split');
    registry.setEditorDirty('a-split', true);

    expect(registry.get('a')).toMatchObject({ dirty: true });
    expect(registry.get('a-split')).toMatchObject({ dirty: true });
    expect(registry.snapshot().layout).toEqual({
      kind: 'split',
      orientation: 'vertical',
      first: { kind: 'group', groupId: 'group-1' },
      second: { kind: 'group', groupId: 'group-b' },
    });
    expect(registry.snapshot().splitRenderingAvailable).toBe(true);
  });

  it('restores empty groups so a later open can target a split pane', () => {
    const registry = new DesktopTabRegistry('window-a');
    registry.restoreStructure(
      [{ id: 'left' }, { id: 'right' }],
      { kind: 'split', orientation: 'horizontal', first: { kind: 'group', groupId: 'left' }, second: { kind: 'group', groupId: 'right' } },
      'right',
    );
    registry.openEditor(p('/tmp/a.md'), 'a.md', 'a', 'left');
    registry.openEditor(p('/tmp/b.md'), 'b.md', 'b', 'right');
    expect(registry.snapshot().activeGroupId).toBe('right');
    expect(registry.snapshot().groups).toHaveLength(2);
    expect(registry.snapshot().splitRenderingAvailable).toBe(true);
  });
});
