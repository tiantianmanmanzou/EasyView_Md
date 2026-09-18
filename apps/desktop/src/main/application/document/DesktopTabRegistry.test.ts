import { describe, expect, it } from 'vitest';
import { DesktopTabRegistry } from './DesktopTabRegistry';

describe('DesktopTabRegistry', () => {
  it('deduplicates file tabs and activates the existing tab', () => {
    const registry = new DesktopTabRegistry();
    const editor = registry.openEditor('/tmp/a.md', 'a.md', 'editor-a');
    registry.openPreview('docs/readme.pdf', 'readme.pdf', 'pdf', 'preview-a');
    const duplicate = registry.openEditor('/tmp/a.md', 'a.md', 'editor-b');

    expect(duplicate.id).toBe(editor.id);
    expect(registry.snapshot()).toMatchObject({ activeTabId: 'editor-a' });
    expect(registry.snapshot().tabs).toHaveLength(2);
  });

  it('keeps dirty state isolated and selects an adjacent tab on close', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor('/tmp/a.md', 'a.md', 'a');
    registry.openEditor('/tmp/b.md', 'b.md', 'b');
    registry.openPreview('c.pdf', 'c.pdf', 'pdf', 'c');
    registry.setEditorDirty('a', true);
    registry.activate('b');

    const active = registry.close('b');
    expect(active?.id).toBe('c');
    expect(registry.get('a')).toMatchObject({ kind: 'editor', dirty: true });
  });

  it('persists file identity without renderer-only state', () => {
    const registry = new DesktopTabRegistry();
    registry.openEditor('/tmp/a.md', 'a.md', 'a');
    registry.setEditorDirty('a', true);
    registry.openPreview('docs/a.pdf', 'a.pdf', 'pdf', 'p');

    expect(registry.persisted()).toEqual([
      { id: 'a', kind: 'editor', filePath: '/tmp/a.md' },
      { id: 'p', kind: 'preview', relativePath: 'docs/a.pdf' },
    ]);
  });
});

describe('DesktopTabRegistry editor groups', () => {
  it('keeps close-others and close-all scoped to the tab group', () => {
    const registry = new DesktopTabRegistry('window-a');
    registry.openEditor('/tmp/a.md', 'a.md', 'a');
    registry.openEditor('/tmp/b.md', 'b.md', 'b');
    registry.split('a', 'right', 'group-b', 'a-split');
    registry.openEditor('/tmp/c.md', 'c.md', 'c', 'group-b');

    expect(registry.closeOthers('a-split').map((tab) => tab.id)).toEqual(['c']);
    expect(registry.snapshot().groups.find((group) => group.id === 'group-1')?.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
    expect(registry.closeAllInGroup('a-split').map((tab) => tab.id)).toEqual(['a-split']);
    expect(registry.snapshot().groups).toHaveLength(1);
  });

  it('shares dirty identity across split views and produces a real layout tree', () => {
    const registry = new DesktopTabRegistry('window-a');
    registry.openEditor('/tmp/a.md', 'a.md', 'a');
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
  });
});
