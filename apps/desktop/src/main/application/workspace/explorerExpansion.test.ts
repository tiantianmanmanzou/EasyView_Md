import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExplorerExpansionStore } from './explorerExpansion';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-explorer-expansion-')));
  temporaryDirectories.push(directory);
  return directory;
}

describe('ExplorerExpansionStore', () => {
  it('remembers expanded folders per root across instances', async () => {
    const userData = await temporaryDirectory();
    const store = new ExplorerExpansionStore(userData);
    await store.remember('/work/a', ['docs', 'docs/api']);
    await store.remember('/work/b', ['notes']);
    await store.remember('/work/a', ['docs']);

    const reloaded = new ExplorerExpansionStore(userData);
    expect(await reloaded.get('/work/a')).toEqual(['docs']);
    expect(await reloaded.get('/work/b')).toEqual(['notes']);
    expect(await reloaded.get('/work/unknown')).toEqual([]);
  });

  it('forgets the least recently used roots beyond the limit', async () => {
    const userData = await temporaryDirectory();
    const store = new ExplorerExpansionStore(userData);
    for (let index = 0; index < 51; index += 1) await store.remember(`/work/${index}`, ['docs']);

    const reloaded = new ExplorerExpansionStore(userData);
    expect(await reloaded.get('/work/0')).toEqual([]);
    expect(await reloaded.get('/work/50')).toEqual(['docs']);
  });
});
