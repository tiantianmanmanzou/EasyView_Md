// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopTabSnapshot } from '../contracts';
import { ActiveViewController } from './ActiveViewController';

function snapshot(overrides: Partial<DesktopTabSnapshot> = {}): DesktopTabSnapshot {
  return {
    windowId: 'main',
    groups: [
      {
        id: 'group-1',
        activeTabId: 'a',
        tabs: [{ id: 'a', kind: 'editor', filePath: '/tmp/a.md', fileName: 'a.md', dirty: false, documentKey: '/tmp/a.md' }],
      },
      {
        id: 'group-b',
        activeTabId: 'b',
        tabs: [{ id: 'b', kind: 'editor', filePath: '/tmp/b.md', fileName: 'b.md', dirty: false, documentKey: '/tmp/b.md' }],
      },
    ],
    activeGroupId: 'group-b',
    layout: {
      kind: 'split',
      orientation: 'horizontal',
      first: { kind: 'group', groupId: 'group-1' },
      second: { kind: 'group', groupId: 'group-b' },
    },
    tabs: [{ id: 'b', kind: 'editor', filePath: '/tmp/b.md', fileName: 'b.md', dirty: false, documentKey: '/tmp/b.md' }],
    activeTabId: 'b',
    splitRenderingAvailable: true,
    ...overrides,
  };
}

describe('ActiveViewController split panes', () => {
  const nodes: HTMLElement[] = [];

  afterEach(() => {
    for (const node of nodes.splice(0)) node.remove();
  });

  function createController() {
    const splitRoot = document.createElement('div');
    splitRoot.id = 'desktop-split-root';
    const group = document.createElement('section');
    group.className = 'desktop-editor-group';
    group.dataset.groupId = 'group-1';
    const tabBar = document.createElement('div');
    tabBar.id = 'desktop-tab-bar';
    tabBar.className = 'desktop-tab-bar';
    const editorBody = document.createElement('div');
    editorBody.id = 'desktop-editor-mount';
    const previewBody = document.createElement('div');
    previewBody.id = 'file-preview-root';
    group.append(tabBar, editorBody, previewBody);
    splitRoot.append(group);
    document.body.append(splitRoot);
    nodes.push(splitRoot);
    const activate = vi.fn();
    const controller = new ActiveViewController({
      api: {
        tabs: {
          activate,
          close: vi.fn(),
          showContextMenu: vi.fn(),
        },
      } as never,
      splitRoot,
      editorBody,
      previewBody,
      tabBar,
      onViewChanged: vi.fn(),
    });
    return { controller, splitRoot, activate };
  }

  it('renders two editor groups side by side and keeps both mounts available', async () => {
    const { controller, splitRoot } = createController();
    await controller.showSnapshot(snapshot());
    expect(splitRoot.querySelector('.desktop-split')?.getAttribute('data-orientation')).toBe('horizontal');
    expect(splitRoot.querySelectorAll('.desktop-editor-group')).toHaveLength(2);
    expect(controller.editorMounts().size).toBe(2);
    expect([...controller.editorMounts().values()].every((mount) => !mount.hidden)).toBe(true);
    expect(splitRoot.querySelectorAll('.desktop-tab')).toHaveLength(2);
    expect(controller.getState()).toMatchObject({ kind: 'editor', tabId: 'b' });
  });

  it('activates the other pane when it is clicked', async () => {
    const { controller, splitRoot, activate } = createController();
    await controller.showSnapshot(snapshot());
    const left = splitRoot.querySelector<HTMLElement>('[data-group-id="group-1"]');
    left?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    expect(activate).toHaveBeenCalledWith('a');
  });
});
