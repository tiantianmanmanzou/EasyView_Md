import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppStateStore } from './appState';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

async function createTemporaryUserDataPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-app-state-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('AppStateStore', () => {
  it('loads recent files and valid window bounds from the state file', async () => {
    const userDataPath = await createTemporaryUserDataPath();
    await fs.writeFile(
      path.join(userDataPath, 'desktop-state.json'),
      JSON.stringify({
        recentFiles: ['/a.md', 1, '/b.md', null],
        windowBounds: { x: 12, y: 24, width: 1200, height: 800 },
      }),
    );

    const store = createAppStateStore(userDataPath);
    await store.load();

    expect(store.getRecentFiles()).toEqual(['/a.md', '/b.md']);
    expect(store.getWindowBounds()).toEqual({ x: 12, y: 24, width: 1200, height: 800 });
    store.dispose();
  });

  it('discards invalid bounds and writes state atomically', async () => {
    const userDataPath = await createTemporaryUserDataPath();
    const store = createAppStateStore(userDataPath);
    store.setWindowBounds({ x: 1, y: 2, width: 1440, height: 960 });
    store.rememberRecentFile('/notes.md');

    await store.save();

    const saved = JSON.parse(await fs.readFile(path.join(userDataPath, 'desktop-state.json'), 'utf8'));
    expect(saved).toEqual({
      recentFiles: ['/notes.md'],
      windowBounds: { x: 1, y: 2, width: 1440, height: 960 },
      workspace: {
        rootPath: null,
        openTabs: [],
        activeTabId: null,
        expandedRelativePaths: [],
        explorerVisible: true,
        outlineVisible: true,
        explorerWidth: 280,
        outlineWidth: 280,
      },
    });

    await fs.writeFile(
      path.join(userDataPath, 'desktop-state.json'),
      JSON.stringify({ windowBounds: { width: 640, height: 480 } }),
    );
    await store.load();
    expect(store.getWindowBounds()).toBeUndefined();
    store.dispose();
  });

  it('deduplicates and limits recent files while preserving newest first order', async () => {
    const userDataPath = await createTemporaryUserDataPath();
    const store = createAppStateStore(userDataPath, { saveDelayMs: 10_000 });

    for (let index = 0; index < 11; index += 1) {
      store.rememberRecentFile(`/notes-${index}.md`);
    }
    store.rememberRecentFile('/notes-5.md');

    expect(store.getRecentFiles()).toEqual([
      '/notes-5.md',
      '/notes-10.md',
      '/notes-9.md',
      '/notes-8.md',
      '/notes-7.md',
      '/notes-6.md',
      '/notes-4.md',
      '/notes-3.md',
      '/notes-2.md',
      '/notes-1.md',
    ]);
    store.dispose();
  });

  it('migrates the legacy active document into the tab collection', async () => {
    const userDataPath = await createTemporaryUserDataPath();
    await fs.writeFile(path.join(userDataPath, 'desktop-state.json'), JSON.stringify({
      workspace: { rootPath: '/workspace', activeDocumentPath: '/workspace/a.md' },
    }));

    const store = createAppStateStore(userDataPath);
    await store.load();

    expect(store.getWorkspace()).toMatchObject({
      openTabs: [{ id: 'legacy-active-document', kind: 'editor', filePath: '/workspace/a.md' }],
      activeTabId: 'legacy-active-document',
    });
    store.dispose();
  });

  it('persists deferred changes after the save delay', async () => {
    const userDataPath = await createTemporaryUserDataPath();
    const store = createAppStateStore(userDataPath, { saveDelayMs: 10 });
    store.rememberRecentFile('/deferred.md');

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(JSON.parse(await fs.readFile(path.join(userDataPath, 'desktop-state.json'), 'utf8'))).toEqual({
      recentFiles: ['/deferred.md'],
      workspace: {
        rootPath: null,
        openTabs: [],
        activeTabId: null,
        expandedRelativePaths: [],
        explorerVisible: true,
        outlineVisible: true,
        explorerWidth: 280,
        outlineWidth: 280,
      },
    });
    store.dispose();
  });

  it('persists window zoom level within Chromium/VS Code bounds', async () => {
    const userDataPath = await createTemporaryUserDataPath();
    const store = createAppStateStore(userDataPath);
    expect(store.getZoomLevel()).toBe(0);
    store.setZoomLevel(2);
    expect(store.getZoomLevel()).toBe(2);
    store.setZoomLevel(99);
    expect(store.getZoomLevel()).toBe(5);
    store.setZoomLevel(-99);
    expect(store.getZoomLevel()).toBe(-5);
    await store.save();
    store.dispose();

    const reloaded = createAppStateStore(userDataPath);
    await reloaded.load();
    expect(reloaded.getZoomLevel()).toBe(-5);
    reloaded.dispose();
  });
});
