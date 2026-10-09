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
