import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const vscodeMocks = vi.hoisted(() => {
  const fileWatchers: Array<{
    onDidCreate: (listener: () => void) => void;
    onDidChange: (listener: () => void) => void;
    onDidDelete: (listener: () => void) => void;
    fireCreate: () => void;
    fireChange: () => void;
    fireDelete: () => void;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const emitters: Array<{ fire: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; event: unknown }> = [];
  const providers: unknown[] = [];

  class EventEmitter<T> {
    public readonly fire = vi.fn<(event: T) => void>();
    public readonly dispose = vi.fn();
    public readonly event = vi.fn();

    constructor() {
      emitters.push(this);
    }
  }

  class Disposable {
    constructor(private readonly callback: () => void) {}

    dispose(): void {
      this.callback();
    }

    static from(...disposables: Array<{ dispose: () => void }>): Disposable {
      return new Disposable(() => disposables.forEach((disposable) => disposable.dispose()));
    }
  }

  return {
    fileWatchers,
    emitters,
    providers,
    EventEmitter,
    Disposable,
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FileSystemError: {
      FileNotFound: () => Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' }),
      FileExists: () => Object.assign(new Error('FileExists'), { code: 'FileExists' }),
    },
    Uri: {
      file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => `file:${fsPath}` }),
    },
    RelativePattern: class RelativePattern {
      constructor(public readonly baseUri: unknown, public readonly pattern: string) {}
    },
    workspace: {
      createFileSystemWatcher: vi.fn(() => {
        let onCreate: (() => void) | undefined;
        let onChange: (() => void) | undefined;
        let onDelete: (() => void) | undefined;
        const watcher = {
          onDidCreate: (listener: () => void) => { onCreate = listener; },
          onDidChange: (listener: () => void) => { onChange = listener; },
          onDidDelete: (listener: () => void) => { onDelete = listener; },
          fireCreate: () => onCreate?.(),
          fireChange: () => onChange?.(),
          fireDelete: () => onDelete?.(),
          dispose: vi.fn(),
        };
        fileWatchers.push(watcher);
        return watcher;
      }),
      registerFileSystemProvider: vi.fn((_scheme: string, provider: unknown) => {
        providers.push(provider);
        return new Disposable(() => undefined);
      }),
      fs: {
        stat: vi.fn(),
        readDirectory: vi.fn(),
        createDirectory: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        delete: vi.fn(),
        rename: vi.fn(),
        copy: vi.fn(),
      },
    },
  };
});

vi.mock('vscode', () => vscodeMocks);

import { registerEasyViewMarkdownFileSystem } from './markdownFileSystem';

type MarkdownFileSystemProvider = {
  watch(uri: { toString(skipEncoding?: boolean): string; with(change: { scheme: string }): unknown }): { dispose(): void };
  writeFile(uri: unknown, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void>;
};

describe('EasyView markdown file system', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vscodeMocks.fileWatchers.length = 0;
    vscodeMocks.emitters.length = 0;
    vscodeMocks.providers.length = 0;
    vi.clearAllMocks();
    vscodeMocks.workspace.fs.readFile.mockResolvedValue(new Uint8Array([1]));
  });

  it('forwards real disk content changes to the easyviewMd document', async () => {
    const registration = registerEasyViewMarkdownFileSystem();
    const provider = vscodeMocks.providers[0] as MarkdownFileSystemProvider;
    const uri = {
      fsPath: '/workspace/docs/example.md',
      scheme: 'easyviewMd',
      toString: () => 'easyviewMd:/workspace/docs/example.md',
      with: ({ scheme }: { scheme: string }) => ({
        fsPath: '/workspace/docs/example.md',
        scheme,
        toString: () => `${scheme}:/workspace/docs/example.md`,
      }),
    };

    const watchedDocument = provider.watch(uri);
    await Promise.resolve();
    vscodeMocks.workspace.fs.readFile.mockResolvedValue(new Uint8Array([2]));
    vscodeMocks.fileWatchers[0].fireChange();
    vscodeMocks.fileWatchers[0].fireChange();
    vscodeMocks.fileWatchers[0].fireChange();

    expect(vscodeMocks.emitters[0].fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(vscodeMocks.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    expect(vscodeMocks.emitters[0].fire).toHaveBeenCalledWith([
      { type: vscodeMocks.FileChangeType.Changed, uri },
    ]);

    watchedDocument.dispose();
    expect(vscodeMocks.fileWatchers[0].dispose).toHaveBeenCalledTimes(1);
    registration.dispose();
  });

  it('drops repeated native notifications when disk content did not change', async () => {
    const registration = registerEasyViewMarkdownFileSystem();
    const provider = vscodeMocks.providers[0] as MarkdownFileSystemProvider;
    const uri = {
      fsPath: '/workspace/docs/example.md',
      scheme: 'easyviewMd',
      toString: () => 'easyviewMd:/workspace/docs/example.md',
      with: ({ scheme }: { scheme: string }) => ({
        fsPath: '/workspace/docs/example.md',
        scheme,
        toString: () => `${scheme}:/workspace/docs/example.md`,
      }),
    };

    provider.watch(uri);
    await Promise.resolve();
    for (let index = 0; index < 10_000; index += 1) {
      vscodeMocks.fileWatchers[0].fireChange();
    }

    await vi.advanceTimersByTimeAsync(100);
    expect(vscodeMocks.workspace.fs.readFile).toHaveBeenCalledTimes(2);
    expect(vscodeMocks.emitters[0].fire).not.toHaveBeenCalled();

    registration.dispose();
  });

  it('does not recreate the old path after rename when saving an existing file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easyview-rename-save-'));
    const registration = registerEasyViewMarkdownFileSystem();
    try {
      const oldPath = path.join(directory, 'old.md');
      const nextPath = path.join(directory, 'new.md');
      await writeFile(oldPath, 'original');
      await rename(oldPath, nextPath);
      const provider = vscodeMocks.providers[0] as MarkdownFileSystemProvider;
      await expect(provider.writeFile(vscodeMocks.Uri.file(oldPath), new Uint8Array([1]), {
        create: false, overwrite: true,
      })).rejects.toMatchObject({ code: 'FileNotFound' });
      await expect(readFile(oldPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(nextPath, 'utf8')).toBe('original');
    } finally {
      registration.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('honors creation and overwrite options and truncates shorter saved content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easyview-write-options-'));
    const registration = registerEasyViewMarkdownFileSystem();
    try {
      const filePath = path.join(directory, 'document.md');
      const uri = vscodeMocks.Uri.file(filePath);
      const provider = vscodeMocks.providers[0] as MarkdownFileSystemProvider;
      await provider.writeFile(uri, Buffer.from('long original'), { create: true, overwrite: false });
      await expect(provider.writeFile(uri, Buffer.from('bad'), { create: true, overwrite: false }))
        .rejects.toMatchObject({ code: 'FileExists' });
      await expect(provider.writeFile(uri, Buffer.from('bad'), { create: false, overwrite: false }))
        .rejects.toMatchObject({ code: 'FileExists' });
      expect(await readFile(filePath, 'utf8')).toBe('long original');
      await provider.writeFile(uri, Buffer.from('short'), { create: false, overwrite: true });
      expect(await readFile(filePath, 'utf8')).toBe('short');
    } finally {
      registration.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
