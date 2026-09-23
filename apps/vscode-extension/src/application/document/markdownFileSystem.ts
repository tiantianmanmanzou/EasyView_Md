import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  EASYVIEW_MD_SCHEME,
  toDiskFileUri,
} from './markdownUri';

let retainEasyViewMarkdownDiskWatch: ((uri: vscode.Uri) => vscode.Disposable) | undefined;

/**
 * Read/write mirror of `file://` markdown paths.
 * CustomTextEditor opens `easyviewMd:` URIs so bytes are served by this extension
 * host — avoiding Cursor failures that leave nested-git `file://` docs unsynced.
 */
export function registerEasyViewMarkdownFileSystem(): vscode.Disposable {
  const changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  type DiskWatchState = {
    references: number;
    watcher: vscode.FileSystemWatcher;
    diskUri: vscode.Uri;
    sourceUri: vscode.Uri;
    signature: string | undefined;
    timer: NodeJS.Timeout | undefined;
    hint: vscode.FileChangeType;
    disposed: boolean;
  };
  const diskWatchers = new Map<string, DiskWatchState>();

  const diskKey = (uri: vscode.Uri): string => toDiskFileUri(uri).toString(true);

  const readDiskSignature = async (diskUri: vscode.Uri): Promise<string> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(diskUri);
      return `${bytes.byteLength}:${createHash('sha1').update(bytes).digest('hex')}`;
    } catch {
      return 'missing';
    }
  };

  const reconcileDiskState = async (state: DiskWatchState): Promise<void> => {
    if (state.disposed) return;
    const nextSignature = await readDiskSignature(state.diskUri);
    if (state.disposed || nextSignature === state.signature) return;

    const previousSignature = state.signature;
    state.signature = nextSignature;
    const type = nextSignature === 'missing'
      ? vscode.FileChangeType.Deleted
      : previousSignature === 'missing'
        ? vscode.FileChangeType.Created
        : previousSignature === undefined
          ? state.hint
          : vscode.FileChangeType.Changed;
    changeEmitter.fire([{ type, uri: state.sourceUri }]);
  };

  const scheduleReconcile = (state: DiskWatchState, hint: vscode.FileChangeType): void => {
    state.hint = hint;
    if (state.timer) clearTimeout(state.timer);
    // Native file watchers can emit very large duplicate bursts for one save.
    // Reconcile the final file content once and emit only a real state change.
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void reconcileDiskState(state);
    }, 100);
  };

  const retainDiskWatcher = (uri: vscode.Uri): vscode.Disposable => {
    const key = diskKey(uri);
    const existing = diskWatchers.get(key);
    if (existing) {
      existing.references += 1;
    } else {
      const diskUri = toDiskFileUri(uri);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(diskUri.fsPath)), path.basename(diskUri.fsPath)),
        false,
        false,
        false,
      );
      const state: DiskWatchState = {
        references: 1,
        watcher,
        diskUri,
        sourceUri: uri,
        signature: undefined,
        timer: undefined,
        hint: vscode.FileChangeType.Changed,
        disposed: false,
      };
      watcher.onDidCreate(() => scheduleReconcile(state, vscode.FileChangeType.Created));
      watcher.onDidChange(() => scheduleReconcile(state, vscode.FileChangeType.Changed));
      watcher.onDidDelete(() => scheduleReconcile(state, vscode.FileChangeType.Deleted));
      diskWatchers.set(key, state);
      // Establish the semantic baseline. A racing native notification still
      // reconciles against the final content and cannot create an event loop.
      void readDiskSignature(diskUri).then((signature) => {
        if (!state.disposed && state.signature === undefined) state.signature = signature;
      });
    }

    return new vscode.Disposable(() => {
      const current = diskWatchers.get(key);
      if (!current) return;
      current.references -= 1;
      if (current.references === 0) {
        current.disposed = true;
        if (current.timer) clearTimeout(current.timer);
        current.watcher.dispose();
        diskWatchers.delete(key);
      }
    });
  };
  retainEasyViewMarkdownDiskWatch = retainDiskWatcher;

  const provider: vscode.FileSystemProvider = {
    onDidChangeFile: changeEmitter.event,

    // The platform may call this for ordinary TextDocuments. Custom editors also
    // retain the same disk watcher explicitly, because Cursor does not always do so.
    watch(uri) {
      return retainDiskWatcher(uri);
    },

    stat(uri) {
      return vscode.workspace.fs.stat(toDiskFileUri(uri));
    },

    readDirectory(uri) {
      return vscode.workspace.fs.readDirectory(toDiskFileUri(uri));
    },

    createDirectory(uri) {
      return vscode.workspace.fs.createDirectory(toDiskFileUri(uri));
    },

    readFile(uri) {
      return vscode.workspace.fs.readFile(toDiskFileUri(uri));
    },

    async writeFile(uri, content, _options) {
      await vscode.workspace.fs.writeFile(toDiskFileUri(uri), content);
      const state = diskWatchers.get(diskKey(uri));
      if (state) state.signature = await readDiskSignature(state.diskUri);
      changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    },

    async delete(uri, options) {
      await vscode.workspace.fs.delete(toDiskFileUri(uri), options);
      const state = diskWatchers.get(diskKey(uri));
      if (state) state.signature = 'missing';
      changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    },

    async rename(oldUri, newUri, options) {
      await vscode.workspace.fs.rename(toDiskFileUri(oldUri), toDiskFileUri(newUri), options);
      const oldState = diskWatchers.get(diskKey(oldUri));
      if (oldState) oldState.signature = 'missing';
      const newState = diskWatchers.get(diskKey(newUri));
      if (newState) newState.signature = await readDiskSignature(newState.diskUri);
      changeEmitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    },

    async copy(source, destination, options) {
      await vscode.workspace.fs.copy(toDiskFileUri(source), toDiskFileUri(destination), options);
      const state = diskWatchers.get(diskKey(destination));
      if (state) state.signature = await readDiskSignature(state.diskUri);
      changeEmitter.fire([{ type: vscode.FileChangeType.Created, uri: destination }]);
    },
  };

  return vscode.Disposable.from(
    changeEmitter,
    { dispose: () => {
      for (const state of diskWatchers.values()) {
        state.disposed = true;
        if (state.timer) clearTimeout(state.timer);
        state.watcher.dispose();
      }
      diskWatchers.clear();
      if (retainEasyViewMarkdownDiskWatch === retainDiskWatcher) {
        retainEasyViewMarkdownDiskWatch = undefined;
      }
    } },
    vscode.workspace.registerFileSystemProvider(EASYVIEW_MD_SCHEME, provider, {
      isCaseSensitive: process.platform !== 'win32',
      isReadonly: false,
    }),
  );
}


/** Retain a disk watcher while an EasyView custom editor is open. */
export function watchEasyViewMarkdownDiskFile(uri: vscode.Uri): vscode.Disposable {
  return retainEasyViewMarkdownDiskWatch?.(uri) ?? new vscode.Disposable(() => undefined);
}
