import * as vscode from 'vscode';
import path from 'node:path';
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

const VIEW_ID = 'easyviewMd.workspaceFiles';
const VIEW_CONTAINER_COMMAND = 'workbench.view.extension.easyviewMd-workspacePanel';
const FOCUS_ON_STARTUP_SETTING = 'workspace.focusFilesOnStartup';
/** Wait for host sidebar restore (Cursor/VS Code) before taking focus. */
const FOCUS_ON_STARTUP_DELAY_MS = 250;
const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;

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
        void vscode.window.showInformationMessage('Open a folder or workspace to configure sorting.');
        return;
      }
      provider.postContextCommand('toggleSortMenu');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.newFile', () => {
      if (!provider.getRootUri()) {
        void vscode.window.showInformationMessage('Open a folder or workspace to create files.');
        return;
      }
      provider.postContextCommand('beginCreateFile');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.newFolder', () => {
      if (!provider.getRootUri()) {
        void vscode.window.showInformationMessage('Open a folder or workspace to create folders.');
        return;
      }
      provider.postContextCommand('beginCreateFolder');
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.revealCurrentFile', () => {
      provider.revealActive(true);
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
          throw new Error(`Unable to open ${workspaceBasename(uri)} with the default application.`);
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
  private rootFolder: vscode.WorkspaceFolder | undefined;
  private selectedRelativePaths: string[] = [];
  private primarySelectedRelativePath: string | null = null;
  private entryClipboard: { rootUri: string; relativePaths: string[] } | null = null;
  private watcher: vscode.FileSystemWatcher | undefined;
  private revealTimer: NodeJS.Timeout | undefined;
  private readonly pendingFileEvents = new Map<string, vscode.Uri>();
  private fileEventTimer: NodeJS.Timeout | undefined;
  private readonly expandedRelativePaths = new Set<string>();
  private readonly entryKindByPath = new Map<string, VscodeWorkspaceEntry['kind']>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly treeService: WorkspaceTreeService,
  ) {}

  dispose(): void {
    this.watcher?.dispose();
    if (this.revealTimer) clearTimeout(this.revealTimer);
    if (this.fileEventTimer) clearTimeout(this.fileEventTimer);
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
    webviewView.title = this.rootFolder?.name || 'Files';

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ...workspaceFolders.map((folder) => folder.uri),
      ],
    };
    webviewView.webview.html = getHtmlForWebview(webviewView.webview, this.context.extensionUri);

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleRequest(message);
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
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
  ): void {
    this.postEvent({ type: 'contextCommand', command, ...(relativePath ? { relativePath } : {}) });
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
      : `${paths.length} selected items`;
    const confirmation = await vscode.window.showWarningMessage(
      `Delete ${label}? Items will be moved to the Trash when available.`,
      { modal: true },
      'Move to Trash',
    );
    if (confirmation !== 'Move to Trash') return;

    for (const relativePath of paths) {
      await this.treeService.delete(root, relativePath);
    }
    this.treeService.invalidate(root, paths);
    this.postEvent({
      type: 'fsChanged',
      relativePaths: [...new Set(paths.map(parentRelativePathOf))],
    });
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

  private postEvent(event: WorkspaceExplorerEvent): void {
    void this.view?.webview.postMessage(event);
  }

  private currentSort(): WorkspaceExplorerSortConfig {
    return {
      sortMode: this.treeService.getSortMode(),
      showCreatedAt: this.treeService.getShowCreatedAt(),
      showUpdatedAt: this.treeService.getShowUpdatedAt(),
      showDotEntries: this.treeService.getShowDotEntries(),
      showTimestampHover: this.treeService.getShowTimestampHover(),
    };
  }

  private postBootstrap(): void {
    const root = this.rootFolder;
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
    });
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
      this.view.title = nextRoot?.name || 'Files';
    }

    if (changed) {
      this.expandedRelativePaths.clear();
      this.entryKindByPath.clear();
      this.selectedRelativePaths = [];
      this.primarySelectedRelativePath = null;
      void this.updateSelectionContext();
      this.treeService.setRoot(nextRoot?.uri, () => {
        this.postBootstrap();
      });
      this.replaceWatcher(nextRoot);
      if (options.announceRootChanged) {
        this.postEvent({ type: 'rootChanged' });
      }
      if (!nextRoot) {
        this.postBootstrap();
      }
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
    this.watcher.onDidChange((uri) => this.queueFileEvent(uri));
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
        this.updateRoot({ bootstrap: true });
        return;
      case 'listChildren':
        await this.handleListChildren(message.requestId, message.relativePath);
        return;
      case 'setExpanded':
        if (message.expanded) this.expandedRelativePaths.add(message.relativePath);
        else this.expandedRelativePaths.delete(message.relativePath);
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
        message: 'No active workspace root.',
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
      });
    }
  }

  private requireRoot(): vscode.Uri {
    const root = this.rootFolder?.uri;
    if (!root) throw new Error('No active workspace root.');
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
      throw new Error(`Unable to open ${workspaceBasename(uri)} with the default application.`);
    }
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
        throw new Error('Clipboard is empty.');
      }
      if (this.entryClipboard.rootUri !== root.toString(true)) {
        throw new Error('Clipboard entry belongs to another workspace root.');
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
  if (MARKDOWN_EXTENSION.test(uri.path)) {
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
  };
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
<html lang="en">
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
  <title>Files</title>
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

  return setTimeout(() => {
    void vscode.commands.executeCommand(VIEW_CONTAINER_COMMAND);
  }, FOCUS_ON_STARTUP_DELAY_MS);
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
    return candidate as vscode.Uri;
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.scheme !== 'untitled') return activeDocument.uri;
  return undefined;
}

function parentRelativePathOf(relativePath: string): string {
  return relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
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
