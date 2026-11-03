import { VscodeTimeline } from '../timeline/vscodeTimeline';
import { copyFilesToSystemClipboard, type TimelineChannel } from '@easyview/node-runtime';
import { isMarkdownFilePath, WORKSPACE_CREATABLE_FILE_TYPES, type TimelineRequestMessage } from '@easyview/contracts';
import * as vscode from 'vscode';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveMarkdownDiskUri } from '../application/document/openMarkdownEditor';
import { indexAreaRelativePath } from './indexAreaPath';
import { resolvePreviewRoute } from '@easyview/contracts/preview';
import { isPhase1PreviewRoute } from '@easyview/preview-ui/phase1';
import {
  WorkspaceTreeService,
  type VscodeWorkspaceEntry,
  workspaceBasename,
  workspaceRelativePath,
} from './workspaceApi';
import {
  isWorkspaceExplorerRequest,
  type WorkspaceExplorerEntry,
  type WorkspaceExplorerEvent,
  type WorkspaceExplorerRequest,
  type WorkspaceExplorerSortConfig,
} from './webview/workspace-explorer-messages';
import { openMarkdownInEasyViewEditor } from '../application/document/openMarkdownEditor';
import { getLocale } from '@easyview/contracts/i18n';
import { tWorkspace } from './workspace.i18n';

const VIEW_ID = 'easyviewMd.workspaceFiles';
const VIEW_CONTAINER_COMMAND = 'workbench.view.extension.easyviewMd-workspacePanel';
const FOCUS_ON_STARTUP_SETTING = 'workspace.focusFilesOnStartup';
const EXPANDED_STATE_KEY = 'easyviewMd.workspace.expandedByRoot';
/** Startup activation can precede the host's sidebar restore (Cursor/VS Code), which reopens Explorer; focus again after it. */
const FOCUS_ON_STARTUP_DELAY_MS = 250;
const WEBVIEW_READY_TIMEOUT_MS = 5_000;
const WEBVIEW_READY_RETRIES = 2;

export function registerWorkspaceExplorer(context: vscode.ExtensionContext): vscode.Disposable {
  const treeService = new WorkspaceTreeService();
  const provider = new WorkspaceExplorerViewProvider(context, treeService);
  const startupFocusTimer = scheduleFocusWorkspacePanelOnStartup();

  const disposables: vscode.Disposable[] = [
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.handleWorkspaceFoldersChanged();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      provider.scheduleRevealActive();
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      provider.scheduleRevealActive();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      provider.scheduleRevealActive();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      provider.handleWindowFocused();
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.refresh', () => {
      provider.postContextCommand('refresh');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.collapseAll', () => {
      provider.postContextCommand('collapseAll');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.configureSort', () => {
      if (!provider.getRootUri()) {
        void vscode.window.showInformationMessage(tWorkspace('noRoot.sort'));
        return;
      }
      provider.postContextCommand('toggleSortMenu');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.search', () => {
      if (!provider.getRootUri()) {
        void vscode.window.showInformationMessage(tWorkspace('noRoot.search'));
        return;
      }
      provider.postContextCommand('toggleSearch');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.newFile', () => {
      if (!provider.getRootUri()) {
        void vscode.window.showInformationMessage(tWorkspace('noRoot.createFile'));
        return;
      }
      void (async () => {
        const picked = await vscode.window.showQuickPick(
          WORKSPACE_CREATABLE_FILE_TYPES.map((type) => ({
            label: ({
              markdown: tWorkspace('create.type.markdown'),
              word: tWorkspace('create.type.word'),
              excel: tWorkspace('create.type.excel'),
              text: tWorkspace('create.type.text'),
            } as const)[type.id],
            extension: type.extension,
          })),
          { title: tWorkspace('create.pickType'), placeHolder: tWorkspace('create.pickType') },
        );
        if (!picked) return;
        // The OS IME anchors to the workbench's focused element; give it the view, not the title button or editor.
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        provider.postContextCommand('beginCreateFile', undefined, picked.extension);
      })();
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.newFolder', async () => {
      if (!provider.getRootUri()) {
        void vscode.window.showInformationMessage(tWorkspace('noRoot.createFolder'));
        return;
      }
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      provider.postContextCommand('beginCreateFolder');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.revealCurrentFile', () => {
      provider.revealActive(true);
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.revealInIndexArea', async (target?: unknown) => {
      await provider.revealInIndexArea(target);
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.openPreview', async () => {
      const uri = provider.resolveSelectedFileUri();
      if (!uri) return;
      try {
        await openWorkspaceResource(context, uri);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.openExternal', async () => {
      const uri = provider.resolveSelectedFileUri();
      if (!uri || uri.scheme !== 'file') return;
      try {
        const opened = await vscode.env.openExternal(uri);
        if (!opened) {
          throw new Error(tWorkspace('openExternal.failed', { name: workspaceBasename(uri) }));
        }
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    ...['easyviewMd.workspace.revealMac', 'easyviewMd.workspace.revealWindows', 'easyviewMd.workspace.revealLinux']
      .map((command) => vscode.commands.registerCommand(command, async () => {
        const uri = provider.resolveSelectedEntryUri();
        if (!uri || uri.scheme !== 'file') return;
        await vscode.commands.executeCommand('revealFileInOS', uri);
      })),
    vscode.commands.registerCommand('easyviewMd.workspace.copyResourceUri', async () => {
      try {
        await provider.copySelectionToEntryClipboard();
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.paste', () => {
      const relativePath = provider.getPrimarySelectedRelativePath();
      provider.postContextCommand('paste', relativePath ?? undefined);
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.copyPath', async () => {
      const uri = provider.resolveSelectedEntryUri();
      if (!uri) return;
      await vscode.env.clipboard.writeText(uri.scheme === 'file' ? uri.fsPath : uri.toString(true));
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.copyRelativePath', async () => {
      const relativePath = provider.getPrimarySelectedRelativePath();
      if (relativePath === undefined || relativePath === null) return;
      await vscode.env.clipboard.writeText(relativePath);
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.rename', () => {
      const relativePath = provider.getPrimarySelectedRelativePath();
      if (!relativePath) return;
      provider.postContextCommand('rename', relativePath);
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.delete', async () => {
      try {
        await provider.deleteSelectedWithConfirm();
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
  ];

  provider.initialize();

  return vscode.Disposable.from(...disposables, {
    dispose: () => {
      if (startupFocusTimer) clearTimeout(startupFocusTimer);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.fileSelected', false);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.entrySelected', false);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.hasClipboard', false);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.inputFocus', false);
    },
  });
}

class WorkspaceExplorerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private timeline: VscodeTimeline;
  private timelineChannel?: TimelineChannel;
  private rootFolder: vscode.WorkspaceFolder | undefined;
  private selectedRelativePaths: string[] = [];
  private primarySelectedRelativePath: string | null = null;
  private entryClipboard: { rootUri: string; relativePaths: string[] } | null = null;
  private watcher: vscode.FileSystemWatcher | undefined;
  private revealTimer: NodeJS.Timeout | undefined;
  private readonly pendingFileEvents = new Map<string, vscode.Uri>();
  private fileEventTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private readyAttempts = 0;
  private viewReady = false;
  private readonly expandedRelativePaths = new Set<string>();
  private bootstrapSequence = 0;
  private readonly entryKindByPath = new Map<string, VscodeWorkspaceEntry['kind']>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly treeService: WorkspaceTreeService,
  ) { this.timeline = new VscodeTimeline(context); }

  dispose(): void {
    if (this.timelineChannel) this.timeline.releaseChannel(this.timelineChannel); this.timeline.dispose();
    this.watcher?.dispose();
    if (this.revealTimer) clearTimeout(this.revealTimer);
    if (this.fileEventTimer) clearTimeout(this.fileEventTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
  }

  initialize(): void {
    this.updateRoot({ bootstrap: false });
    void this.updateSelectionContext();
    void this.updateClipboardContext();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.viewReady = false;
    this.readyAttempts = 0;
    webviewView.title = this.rootFolder?.name || tWorkspace('viewTitle');

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ...workspaceFolders.map((folder) => folder.uri),
      ],
    };
    const channelReady = this.timeline.channel(() => this.rootFolder?.uri.fsPath, (message) => { void webviewView.webview.postMessage(message); }).then((channel) => { if (this.timelineChannel) this.timeline.releaseChannel(this.timelineChannel); this.timelineChannel = channel; return channel; });
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (message && typeof message === 'object' && String((message as { type?: string }).type).startsWith('timeline.')) {
        void channelReady.then((channel) => channel.handle(message as TimelineRequestMessage)).catch((error) => { this.timeline.report(error); if ('id' in message) void webviewView.webview.postMessage({ type: 'timeline.result', id: message.id, error: error instanceof Error ? error.message : String(error) }); });
      } else void this.handleRequest(message);
    });
    webviewView.onDidChangeVisibility(() => {
      void webviewView.webview.postMessage({ type: 'timeline.visibility', visible: webviewView.visible });
      if (!webviewView.visible) void channelReady.then((channel) => channel.handle({ type: 'timeline.watch', filePath: null }));
    });
    webviewView.onDidDispose(() => { void channelReady.then((channel) => this.timeline.releaseChannel(channel)); });
    this.watchWebviewReady(webviewView);
    webviewView.webview.html = getHtmlForWebview(webviewView.webview, this.context.extensionUri);

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
    });
  }

  private watchWebviewReady(view: vscode.WebviewView): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      if (this.view !== view || this.viewReady) return;
      if (this.readyAttempts >= WEBVIEW_READY_RETRIES) {
        void vscode.window.showErrorMessage(tWorkspace('view.loadFailed'));
        return;
      }
      this.readyAttempts += 1;
      this.watchWebviewReady(view);
      view.webview.html = getHtmlForWebview(view.webview, this.context.extensionUri);
    }, WEBVIEW_READY_TIMEOUT_MS);
  }

  getRootUri(): vscode.Uri | undefined {
    return this.rootFolder?.uri;
  }

  getPrimarySelectedRelativePath(): string | null {
    return this.primarySelectedRelativePath;
  }

  postContextCommand(
    command: Extract<WorkspaceExplorerEvent, { type: 'contextCommand' }>['command'],
    relativePath?: string,
    extension?: string,
  ): void {
    this.postEvent({
      type: 'contextCommand',
      command,
      ...(relativePath ? { relativePath } : {}),
      ...(extension ? { extension } : {}),
    });
  }

  resolveSelectedFileUri(): vscode.Uri | undefined {
    const relativePath = this.primarySelectedRelativePath;
    const root = this.rootFolder?.uri;
    if (!root || !relativePath) return undefined;
    return uriFromRelativePath(root, relativePath);
  }

  resolveSelectedEntryUri(): vscode.Uri | undefined {
    return this.resolveSelectedFileUri();
  }

  async copySelectionToEntryClipboard(): Promise<void> {
    const root = this.rootFolder?.uri;
    const paths = this.selectedRelativePaths.length > 0
      ? this.selectedRelativePaths
      : this.primarySelectedRelativePath
        ? [this.primarySelectedRelativePath]
        : [];
    if (!root || paths.length === 0) return;
    this.entryClipboard = { rootUri: root.toString(true), relativePaths: [...paths] };
    await this.updateClipboardContext();
    this.postEvent({ type: 'clipboardChanged', hasClipboard: true });
    const first = uriFromRelativePath(root, paths[0]);
    await vscode.env.clipboard.writeText(first.scheme === 'file' ? first.fsPath : first.toString(true));
  }

  async deleteSelectedWithConfirm(): Promise<void> {
    const root = this.rootFolder?.uri;
    const paths = this.selectedRelativePaths.filter(Boolean);
    if (!root || paths.length === 0) return;

    const label = paths.length === 1
      ? `“${path.posix.basename(paths[0])}”`
      : tWorkspace('delete.selectedItems', { count: paths.length });
    const moveToTrashAction = tWorkspace('delete.moveToTrash');
    const confirmation = await vscode.window.showWarningMessage(
      tWorkspace('delete.confirm', { label }),
      { modal: true },
      moveToTrashAction,
    );
    if (confirmation !== moveToTrashAction) return;

    for (const relativePath of paths) {
      await this.treeService.delete(root, relativePath);
    }
    this.treeService.invalidate(root, paths);
    this.forgetExpanded(paths);
    this.postEvent({ type: 'entriesDeleted', relativePaths: paths });
    this.postEvent({
      type: 'fsChanged',
      relativePaths: [...new Set(paths.map(parentRelativePathOf))],
    });
  }

  private forgetExpanded(relativePaths: readonly string[]): void {
    for (const expanded of [...this.expandedRelativePaths]) {
      if (relativePaths.some((removed) => expanded === removed || expanded.startsWith(`${removed}/`))) {
        this.expandedRelativePaths.delete(expanded);
      }
    }
    this.saveExpanded();
  }

  handleWorkspaceFoldersChanged(): void {
    this.updateRoot({ bootstrap: true, announceRootChanged: true });
  }

  handleWindowFocused(): void {
    this.updateRoot({ bootstrap: false });
    const root = this.rootFolder?.uri;
    if (root) this.treeService.invalidateAll(root);
    this.postEvent({ type: 'fsChanged', relativePaths: [''] });
    this.scheduleRevealActive();
  }

  scheduleRevealActive(): void {
    this.updateRoot({ bootstrap: false });
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => {
      this.revealTimer = undefined;
      this.revealActive(false);
    }, 50);
  }

  revealActive(force: boolean): void {
    if (!this.view?.visible && !force) return;
    const resource = resolveActiveResourceUri();
    const root = this.rootFolder?.uri;
    if (!resource || !root) return;
    const relativePath = workspaceRelativePath(root, resource);
    if (!relativePath) return;
    this.postEvent({ type: 'reveal', relativePath });
  }

  async revealInIndexArea(target?: unknown): Promise<void> {
    // Tab/explorer menus pass the tab resource. EasyView custom editor tabs use the
    // `easyviewMd:` mirror scheme, so map back to the on-disk file before matching.
    const candidates: vscode.Uri[] = [];
    const targetUri = toUri(target);
    if (targetUri) candidates.push(resolveMarkdownDiskUri(targetUri));
    const active = resolveActiveResourceUri();
    if (active) candidates.push(active);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(tWorkspace('reveal.noFile'));
      return;
    }
    this.updateRoot({ bootstrap: false });
    const root = this.rootFolder?.uri;
    let relativePath: string | undefined;
    if (root) {
      for (const candidate of candidates) {
        relativePath = workspaceRelativePath(root, candidate)
          ?? (candidate.scheme === 'file' && root.scheme === 'file'
            ? indexAreaRelativePath(root.fsPath, candidate.fsPath, {
              caseInsensitive: process.platform === 'darwin' || process.platform === 'win32',
            })
            : undefined);
        if (relativePath) break;
      }
    }
    if (!relativePath) {
      void vscode.window.showInformationMessage(tWorkspace('reveal.notInIndexArea', { name: workspaceBasename(candidates[0]!) }));
      return;
    }
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    for (let attempt = 0; attempt < 40 && !this.view; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.postEvent({ type: 'reveal', relativePath, force: true });
  }

  private postEvent(event: WorkspaceExplorerEvent): void {
    void this.view?.webview.postMessage(event);
  }

  private currentSort(): WorkspaceExplorerSortConfig {
    return {
      sortMode: this.treeService.getSortMode(),
      showCreatedAt: this.treeService.getShowCreatedAt(),
      showUpdatedAt: this.treeService.getShowUpdatedAt(),
      showSize: this.treeService.getShowSize(),
      showSizeHover: this.treeService.getShowSizeHover(),
      showDotEntries: this.treeService.getShowDotEntries(),
      showTimestampHover: this.treeService.getShowTimestampHover(),
    };
  }

  private postBootstrap(): void {
    const root = this.rootFolder;
    const sequence = ++this.bootstrapSequence;
    void this.treeService.whenOrderLoaded().then(() => {
      if (sequence === this.bootstrapSequence && this.rootFolder === root) this.postBootstrapNow(root);
    });
  }

  private postBootstrapNow(root: vscode.WorkspaceFolder | undefined): void {
    const revealResource = resolveActiveResourceUri();
    const revealRelativePath = root && revealResource
      ? workspaceRelativePath(root.uri, revealResource) ?? null
      : null;
    this.postEvent({
      type: 'bootstrap',
      rootName: root?.name ?? null,
      rootUri: root?.uri.toString(true) ?? null,
      sort: this.currentSort(),
      revealRelativePath,
      hasClipboard: this.entryClipboard !== null
        && Boolean(root && this.entryClipboard.rootUri === root.uri.toString(true)),
      expandedRelativePaths: [...this.expandedRelativePaths],
    });
  }

  private savedExpandedByRoot(): Record<string, string[]> {
    return this.context.workspaceState.get<Record<string, string[]>>(EXPANDED_STATE_KEY) ?? {};
  }

  private saveExpanded(): void {
    const root = this.rootFolder?.uri.toString(true);
    if (!root) return;
    void this.context.workspaceState.update(EXPANDED_STATE_KEY, { ...this.savedExpandedByRoot(), [root]: [...this.expandedRelativePaths] });
  }

  private updateRoot(options: { bootstrap: boolean; announceRootChanged?: boolean }): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const activeResource = resolveActiveResourceUri();
    const nextRoot = folders.length === 1
      ? folders[0]
      : activeResource
        ? vscode.workspace.getWorkspaceFolder(activeResource)
        : undefined;

    const previous = this.rootFolder?.uri.toString(true);
    const next = nextRoot?.uri.toString(true);
    const changed = previous !== next;
    this.rootFolder = nextRoot;

    if (this.view) {
      this.view.title = nextRoot?.name || tWorkspace('viewTitle');
    }

    if (changed) {
      this.expandedRelativePaths.clear();
      for (const relativePath of (next ? this.savedExpandedByRoot()[next] : undefined) ?? []) this.expandedRelativePaths.add(relativePath);
      this.entryKindByPath.clear();
      this.selectedRelativePaths = [];
      this.primarySelectedRelativePath = null;
      void this.updateSelectionContext();
      this.treeService.setRoot(nextRoot?.uri);
      this.replaceWatcher(nextRoot);
      if (options.announceRootChanged) {
        this.postEvent({ type: 'rootChanged' });
      }
      this.postBootstrap();
      return true;
    }

    if (options.bootstrap) {
      this.postBootstrap();
    }
    return false;
  }

  private replaceWatcher(rootFolder: vscode.WorkspaceFolder | undefined): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!rootFolder) return;

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootFolder.uri, '**/*'),
    );
    this.watcher.onDidCreate((uri) => this.queueFileEvent(uri));
    this.watcher.onDidChange((uri) => { this.queueFileEvent(uri); if (isMarkdownFilePath(uri.fsPath)) void this.timeline.capture(uri.fsPath); });
    this.watcher.onDidDelete((uri) => this.queueFileEvent(uri));
  }

  private queueFileEvent(uri: vscode.Uri): void {
    this.pendingFileEvents.set(uri.toString(true), uri);
    if (this.fileEventTimer) clearTimeout(this.fileEventTimer);
    this.fileEventTimer = setTimeout(() => {
      this.fileEventTimer = undefined;
      const resources = [...this.pendingFileEvents.values()];
      this.pendingFileEvents.clear();
      this.flushFileEvents(resources);
    }, 80);
  }

  private flushFileEvents(resources: readonly vscode.Uri[]): void {
    const root = this.rootFolder?.uri;
    if (!root) return;

    const invalidatePaths: string[] = [];
    const notifyParents = new Set<string>();
    for (const resource of resources) {
      const relativePath = workspaceRelativePath(root, resource);
      if (relativePath === undefined) continue;
      invalidatePaths.push(relativePath);
      notifyParents.add(parentRelativePathOf(relativePath));
    }
    if (invalidatePaths.length === 0) return;

    this.treeService.invalidate(root, invalidatePaths);
    this.postEvent({ type: 'fsChanged', relativePaths: [...notifyParents] });
    this.revealActive(false);
  }

  private async updateSelectionContext(): Promise<void> {
    const entrySelected = Boolean(this.primarySelectedRelativePath);
    await vscode.commands.executeCommand(
      'setContext',
      'easyviewMd.workspaceFiles.entrySelected',
      entrySelected,
    );
    const kind = this.primarySelectedRelativePath
      ? this.entryKindByPath.get(this.primarySelectedRelativePath)
      : undefined;
    await vscode.commands.executeCommand(
      'setContext',
      'easyviewMd.workspaceFiles.fileSelected',
      kind === 'file' || kind === 'symlink',
    );
  }

  private async updateClipboardContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'easyviewMd.workspaceFiles.hasClipboard',
      this.entryClipboard !== null,
    );
  }

  private async handleRequest(message: unknown): Promise<void> {
    if (!isWorkspaceExplorerRequest(message)) return;

    try {
      await this.dispatchRequest(message);
    } catch (error) {
      const requestId = 'requestId' in message && typeof message.requestId === 'string'
        ? message.requestId
        : undefined;
      if (requestId) {
        this.postEvent({ type: 'opResult', requestId, ok: false, message: errorMessage(error) });
      } else {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }
  }

  private async dispatchRequest(message: WorkspaceExplorerRequest): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.viewReady = true;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
        this.updateRoot({ bootstrap: true });
        return;
      case 'focusContextMenu': {
        // macOS right-clicks reach inactive windows without activating the app.
        // Focus the native application before transferring focus to its webview.
        if (process.platform === 'darwin') {
          const bundleEnd = process.execPath.indexOf('.app/');
          if (bundleEnd < 0) throw new Error(tWorkspace('focus.bundleNotFound'));
          const application = process.execPath.slice(0, bundleEnd + 4);
          await promisify(execFile)('/usr/bin/osascript', [
            '-e', `tell application ${JSON.stringify(application)} to activate`,
          ]);
        }
        this.view?.show(false);
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true });
        return;
      }
      case 'listChildren':
        await this.handleListChildren(message.requestId, message.relativePath);
        return;
      case 'search':
        await this.handleSearch(message.requestId, message.query);
        return;
      case 'setExpanded':
        if (message.expanded) this.expandedRelativePaths.add(message.relativePath);
        else this.expandedRelativePaths.delete(message.relativePath);
        this.saveExpanded();
        return;
      case 'setSelection':
        this.selectedRelativePaths = [...message.relativePaths];
        this.primarySelectedRelativePath = message.anchorRelativePath
          ?? message.relativePaths[message.relativePaths.length - 1]
          ?? null;
        await this.updateSelectionContext();
        return;
      case 'setInputFocus':
        await vscode.commands.executeCommand(
          'setContext',
          'easyviewMd.workspaceFiles.inputFocus',
          message.focused,
        );
        return;
      case 'open':
        await this.handleOpen(message.relativePath);
        return;
      case 'openExternal':
        await this.handleOpenExternal(message.relativePath);
        return;
      case 'convertToMarkdown':
        await this.handleConvertToMarkdown(message.relativePath);
        return;
      case 'revealInOS':
        await this.handleRevealInOS(message.relativePath);
        return;
      case 'create':
        await this.handleCreate(message);
        return;
      case 'rename':
        await this.handleRename(message);
        return;
      case 'delete':
        await this.handleDelete(message);
        return;
      case 'move':
        await this.handleMove(message);
        return;
      case 'reorder':
        await this.handleReorder(message);
        return;
      case 'copy':
        await this.handleCopy(message);
        return;
      case 'paste':
        await this.handlePaste(message);
        return;
      case 'importExternal':
        await this.handleImportExternal(message);
        return;
      case 'copyFile':
        await this.handleCopyFile(message.relativePaths);
        return;
      case 'copyPath':
        await this.handleCopyPath(message.relativePaths);
        return;
      case 'copyRelativePath':
        await this.handleCopyRelativePath(message.relativePaths);
        return;
      case 'getSortConfig':
        this.postEvent({
          type: 'opResult',
          requestId: message.requestId,
          ok: true,
          sort: this.currentSort(),
        });
        return;
      case 'setSortMode':
        await this.treeService.setSortMode(message.sortMode);
        this.postEvent({
          type: 'opResult',
          requestId: message.requestId,
          ok: true,
          sort: this.currentSort(),
        });
        return;
      case 'getEntrySize': {
        const root = this.rootFolder?.uri;
        if (!root) { this.postEvent({ type: 'opResult', requestId: message.requestId, ok: false, message: tWorkspace('noRoot.active') }); return; }
        try {
          const sizeBytes = await this.treeService.getEntrySize(root, message.relativePath);
          this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true, sizeBytes });
        } catch (error) { this.postEvent({ type: 'opResult', requestId: message.requestId, ok: false, message: errorMessage(error) }); }
        return;
      }
      case 'setShowSizeHover':
        await this.treeService.setShowSizeHover(message.showSizeHover);
        this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true, sort: this.currentSort() });
        return;
      case 'setShowSize':
        await this.treeService.setShowSize(message.showSize);
        this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true, sort: this.currentSort() });
        return;
      case 'setShowCreatedAt':
        await this.treeService.setShowCreatedAt(message.showCreatedAt);
        this.postEvent({
          type: 'opResult',
          requestId: message.requestId,
          ok: true,
          sort: this.currentSort(),
        });
        return;
      case 'setShowUpdatedAt':
        await this.treeService.setShowUpdatedAt(message.showUpdatedAt);
        this.postEvent({
          type: 'opResult',
          requestId: message.requestId,
          ok: true,
          sort: this.currentSort(),
        });
        return;
      case 'setShowDotEntries':
        await this.treeService.setShowDotEntries(message.showDotEntries);
        this.postEvent({
          type: 'opResult',
          requestId: message.requestId,
          ok: true,
          sort: this.currentSort(),
        });
        return;
      case 'setShowTimestampHover':
        await this.treeService.setShowTimestampHover(message.showTimestampHover);
        this.postEvent({
          type: 'opResult',
          requestId: message.requestId,
          ok: true,
          sort: this.currentSort(),
        });
        return;
      case 'collapseAll':
        this.expandedRelativePaths.clear();
        this.saveExpanded();
        // Webview already collapsed locally when echoing after contextCommand; no-op reply.
        return;
      case 'refresh': {
        const root = this.rootFolder?.uri;
        this.treeService.invalidateAll(root);
        this.postEvent({ type: 'fsChanged', relativePaths: [''] });
        return;
      }
      case 'showError':
        void vscode.window.showErrorMessage(message.message);
        return;
      default:
        return;
    }
  }

  private async handleListChildren(requestId: string, relativePath: string): Promise<void> {
    const root = this.rootFolder?.uri;
    if (!root) {
      this.postEvent({
        type: 'listChildrenResult',
        requestId,
        ok: false,
        relativePath,
        message: tWorkspace('noRoot.active'),
      });
      return;
    }
    try {
      const entries = await this.treeService.readChildren(root, relativePath);
      for (const entry of entries) {
        this.entryKindByPath.set(entry.relativePath, entry.kind);
      }
      this.postEvent({
        type: 'listChildrenResult',
        requestId,
        ok: true,
        relativePath,
        entries: entries.map(toExplorerEntry),
      });
    } catch (error) {
      this.postEvent({
        type: 'listChildrenResult',
        requestId,
        ok: false,
        relativePath,
        message: errorMessage(error),
        missing: isMissingEntryError(error),
      });
    }
  }

  private async handleSearch(requestId: string, query: string): Promise<void> {
    const root = this.rootFolder?.uri;
    if (!root || typeof query !== 'string' || query.length > 200) {
      this.postEvent({ type: 'searchResult', requestId, ok: false, message: tWorkspace('search.invalid') });
      return;
    }
    try {
      const result = await this.treeService.search(root, query);
      for (const entry of result.entries) this.entryKindByPath.set(entry.relativePath, entry.kind);
      this.postEvent({
        type: 'searchResult',
        requestId,
        ok: true,
        entries: result.entries.map(toExplorerEntry),
        truncated: result.truncated,
      });
    } catch (error) {
      this.postEvent({ type: 'searchResult', requestId, ok: false, message: errorMessage(error) });
    }
  }

  private requireRoot(): vscode.Uri {
    const root = this.rootFolder?.uri;
    if (!root) throw new Error(tWorkspace('noRoot.active'));
    return root;
  }

  private async handleOpen(relativePath: string): Promise<void> {
    const root = this.requireRoot();
    // Keep sidebar focus so Enter can rename after a single-click open.
    await openWorkspaceResource(this.context, uriFromRelativePath(root, relativePath), {
      preserveFocus: true,
    });
  }

  private async handleOpenExternal(relativePath: string): Promise<void> {
    const root = this.requireRoot();
    const uri = uriFromRelativePath(root, relativePath);
    if (uri.scheme !== 'file') return;
    const opened = await vscode.env.openExternal(uri);
    if (!opened) {
      throw new Error(tWorkspace('openExternal.failed', { name: workspaceBasename(uri) }));
    }
  }

  private async handleConvertToMarkdown(relativePath: string): Promise<void> {
    const root = this.requireRoot();
    const uri = uriFromRelativePath(root, relativePath);
    if (uri.scheme !== 'file' || workspaceRelativePath(root, uri) !== relativePath) {
      throw new Error(tWorkspace('convert.workspaceOnly'));
    }
    const extension = path.extname(uri.fsPath).toLowerCase();
    const command = extension === '.pdf' ? 'easyviewMd.convertPdfToMarkdown'
      : extension === '.docx' || extension === '.doc' ? 'easyviewMd.convertWordToMarkdown' : null;
    if (!command) throw new Error(tWorkspace('convert.selectFile'));
    await vscode.commands.executeCommand(command, uri);
  }

  private async handleRevealInOS(relativePath: string): Promise<void> {
    const root = this.requireRoot();
    const uri = uriFromRelativePath(root, relativePath);
    if (uri.scheme !== 'file') return;
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  private async handleCreate(
    message: Extract<WorkspaceExplorerRequest, { type: 'create' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      const entry = await this.treeService.create(root, {
        parentRelativePath: message.parentRelativePath,
        name: message.name,
        kind: message.kind,
      });
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: true,
        entry: toExplorerEntry(entry),
      });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleRename(
    message: Extract<WorkspaceExplorerRequest, { type: 'rename' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      const entry = await this.treeService.rename(root, message.relativePath, message.newName);
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: true,
        entry: toExplorerEntry(entry),
      });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleDelete(
    message: Extract<WorkspaceExplorerRequest, { type: 'delete' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      for (const relativePath of message.relativePaths) {
        await this.treeService.delete(root, relativePath);
      }
      this.forgetExpanded(message.relativePaths);
      this.postEvent({ type: 'entriesDeleted', relativePaths: message.relativePaths });
      this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleMove(
    message: Extract<WorkspaceExplorerRequest, { type: 'move' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      const entry = await this.treeService.move(
        root,
        message.relativePath,
        message.targetParentRelativePath,
      );
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: true,
        entry: toExplorerEntry(entry),
      });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleReorder(
    message: Extract<WorkspaceExplorerRequest, { type: 'reorder' }>,
  ): Promise<void> {
    try {
      await this.treeService.reorder(
        message.parentRelativePath,
        message.movedName,
        message.siblingNames,
        message.beforeName,
      );
      this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleCopy(
    message: Extract<WorkspaceExplorerRequest, { type: 'copy' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      this.entryClipboard = {
        rootUri: root.toString(true),
        relativePaths: [...message.relativePaths],
      };
      await this.updateClipboardContext();
      this.postEvent({ type: 'clipboardChanged', hasClipboard: true });
      this.postEvent({ type: 'opResult', requestId: message.requestId, ok: true });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handlePaste(
    message: Extract<WorkspaceExplorerRequest, { type: 'paste' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      if (!this.entryClipboard) {
        throw new Error(tWorkspace('paste.clipboardEmpty'));
      }
      if (this.entryClipboard.rootUri !== root.toString(true)) {
        throw new Error(tWorkspace('paste.otherRoot'));
      }
      let lastEntry: VscodeWorkspaceEntry | undefined;
      for (const sourceRelativePath of this.entryClipboard.relativePaths) {
        lastEntry = await this.treeService.copy(
          root,
          sourceRelativePath,
          message.targetParentRelativePath,
        );
      }
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: true,
        ...(lastEntry ? { entry: toExplorerEntry(lastEntry) } : {}),
      });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleImportExternal(
    message: Extract<WorkspaceExplorerRequest, { type: 'importExternal' }>,
  ): Promise<void> {
    const root = this.requireRoot();
    try {
      let lastEntry: VscodeWorkspaceEntry | undefined;
      const sourceUris = message.sourceUris ?? [];
      if (sourceUris.length > 0) {
        for (const raw of sourceUris) {
          lastEntry = await this.treeService.importExternalUri(
            root,
            uriFromExternalDropValue(raw),
            message.targetParentRelativePath,
          );
        }
      } else {
        const items = (message.items ?? []).map((item) => ({
          kind: item.kind,
          relativePath: item.relativePath,
          ...(item.dataBase64 ? { data: Uint8Array.from(Buffer.from(item.dataBase64, 'base64')) } : {}),
        }));
        lastEntry = await this.treeService.importExternalItems(root, message.targetParentRelativePath, items);
      }
      if (!lastEntry) throw new Error(tWorkspace('import.noFiles'));
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: true,
        entry: toExplorerEntry(lastEntry),
      });
    } catch (error) {
      this.postEvent({
        type: 'opResult',
        requestId: message.requestId,
        ok: false,
        message: errorMessage(error),
      });
    }
  }

  private async handleCopyFile(relativePaths: readonly string[]): Promise<void> {
    const root = this.requireRoot();
    const uris = relativePaths.map((relativePath) => uriFromRelativePath(root, relativePath));
    if (uris.some((uri) => uri.scheme !== 'file')) throw new Error(tWorkspace('copyFile.localOnly'));
    await copyFilesToSystemClipboard(uris.map((uri) => uri.fsPath));
  }

  private async handleCopyPath(relativePaths: readonly string[]): Promise<void> {
    const root = this.requireRoot();
    const texts = relativePaths.map((relativePath) => {
      const uri = uriFromRelativePath(root, relativePath);
      return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
    });
    if (texts.length === 0) return;
    await vscode.env.clipboard.writeText(texts.join('\n'));
  }

  private async handleCopyRelativePath(relativePaths: readonly string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    await vscode.env.clipboard.writeText(relativePaths.join('\n'));
  }
}

async function openWorkspaceResource(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  options?: { preserveFocus?: boolean },
): Promise<void> {
  const preserveFocus = options?.preserveFocus === true;
  if (isMarkdownFilePath(uri.path)) {
    // Always open via easyviewMd: — direct file:// CustomTextEditor hits Cursor's
    // nested-git TextDocument sync failure before resolveCustomTextEditor runs.
    await openMarkdownInEasyViewEditor(uri, context, {
      preview: true,
      preserveFocus,
    });
    return;
  }
  const route = resolvePreviewRoute(workspaceBasename(uri));
  if (route && isPhase1PreviewRoute(route.route)) {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'easyviewMd.filePreview', {
      preview: true,
      preserveFocus,
    });
    return;
  }
  await vscode.commands.executeCommand('vscode.open', uri, { preview: true, preserveFocus });
}

function toExplorerEntry(entry: VscodeWorkspaceEntry): WorkspaceExplorerEntry {
  return {
    id: entry.id,
    rootId: entry.rootId,
    name: entry.name,
    relativePath: entry.relativePath,
    kind: entry.kind,
    writable: entry.writable,
    ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
    ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
  };
}

function uriFromExternalDropValue(raw: string): vscode.Uri {
  const value = raw.trim();
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')) {
    return vscode.Uri.file(value);
  }
  return vscode.Uri.parse(value);
}

function uriFromRelativePath(root: vscode.Uri, relativePath: string): vscode.Uri {
  return relativePath
    ? vscode.Uri.joinPath(root, ...relativePath.split('/'))
    : root;
}

function getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'workspace-webview.js'),
  );
  return /* html */ `<!DOCTYPE html>
<html lang="${getLocale()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}' ${webview.cspSource};
      img-src ${webview.cspSource} data:;
      font-src ${webview.cspSource};
      connect-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tWorkspace('viewTitle')}</title>
</head>
<body>
  <div id="workspace-explorer-root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function scheduleFocusWorkspacePanelOnStartup(): NodeJS.Timeout | undefined {
  const enabled = vscode.workspace
    .getConfiguration('easyviewMd')
    .get<boolean>(FOCUS_ON_STARTUP_SETTING, true);
  if (!enabled) return undefined;

  const focus = () => {
    if (!vscode.workspace.workspaceFolders?.length) {
      if (vscode.window.tabGroups.all.every((group) => group.tabs.length === 0)) {
        void vscode.commands.executeCommand('workbench.action.closeSidebar');
      }
      return;
    }
    void vscode.commands.executeCommand(VIEW_CONTAINER_COMMAND);
  };
  focus();
  return setTimeout(focus, FOCUS_ON_STARTUP_DELAY_MS);
}

function toUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value && typeof value === 'object') {
    const record = value as { scheme?: unknown; path?: unknown; authority?: unknown; resourceUri?: unknown };
    if (record.resourceUri) return toUri(record.resourceUri);
    if (typeof record.scheme === 'string' && typeof record.path === 'string') {
      return vscode.Uri.from({ scheme: record.scheme, authority: typeof record.authority === 'string' ? record.authority : '', path: record.path });
    }
  }
  return undefined;
}

function resolveActiveResourceUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: unknown } | undefined;
  const candidate = input?.uri;
  if (
    candidate
    && typeof candidate === 'object'
    && 'scheme' in candidate
    && typeof (candidate as { scheme?: unknown }).scheme === 'string'
    && 'toString' in candidate
  ) {
    return resolveMarkdownDiskUri(candidate as vscode.Uri);
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.scheme !== 'untitled') return resolveMarkdownDiskUri(activeDocument.uri);
  return undefined;
}

function parentRelativePathOf(relativePath: string): string {
  return relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'FileNotFound' || /\bENOENT\b|EntryNotFound/.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

