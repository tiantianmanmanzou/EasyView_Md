import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArchivePreviewService } from './ArchivePreviewService';
import { PreviewSessionStore } from './PreviewSession';

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-archive-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('ArchivePreviewService', () => {
  it('lists and exposes only a validated ZIP entry through a session-scoped URL', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'sample.zip'), storedZip('readme.txt', Buffer.from('safe archive content')));
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'sample.zip');
    const archives = new ArchivePreviewService(sessions);

    await expect(archives.list(descriptor.sessionId)).resolves.toEqual([
      { path: 'readme.txt', directory: false, compressedSize: 20, uncompressedSize: 20 },
    ]);
    const entry = await archives.openEntry(descriptor.sessionId, 'readme.txt');
    const contentId = entry.contentUrl.split('/').at(-1)!;
    await expect(sessions.resolveContent(contentId)).resolves.toMatchObject({ kind: 'memory', bytes: Buffer.from('safe archive content') });
  });

  it('rejects a ZIP path traversal entry before the renderer can use it', async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, 'unsafe.zip'), storedZip('../escape.txt', Buffer.from('x')));
    const sessions = new PreviewSessionStore();
    const descriptor = await sessions.open(root, 'unsafe.zip');
    const archives = new ArchivePreviewService(sessions);

    await expect(archives.list(descriptor.sessionId)).rejects.toThrow('路径穿越');
  });
});

function storedZip(name: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBytes.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  content.copy(local, 30 + nameBytes.length);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}
