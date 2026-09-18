import * as vscode from 'vscode';
import path from 'node:path';
import { resolveWorkspaceTreeIcon } from '@easyview/contracts';
import { resolvePreviewRoute } from '@easyview/contracts/preview';
import { isPhase1PreviewRoute } from '@easyview/preview-ui/phase1';
import {
  WorkspaceTreeService,
  type WorkspaceEntryKind,
  type VscodeWorkspaceEntry,
  validateWorkspaceEntryName,
  workspaceBasename,
  workspaceParentUri,
  workspaceRelativePath,
  uniqueWorkspaceCreateName,
} from './workspaceApi';

const VIEW_ID = 'easyviewMd.workspaceFiles';
const VIEW_CONTAINER_COMMAND = 'workbench.view.extension.easyviewMd-workspacePanel';
const FOCUS_ON_STARTUP_SETTING = 'workspace.focusFilesOnStartup';
/** Wait for host sidebar restore (Cursor/VS Code) before taking focus. */
const FOCUS_ON_STARTUP_DELAY_MS = 250;
const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;

type WorkspaceTreeNodeKind = 'root' | WorkspaceEntryKind;

class WorkspaceTreeNode extends vscode.TreeItem {
  readonly id: string;

  constructor(
    readonly uri: vscode.Uri,
    readonly kind: WorkspaceTreeNodeKind,
    readonly relativePath: string,
    readonly writable: boolean,
    readonly parentId: string | undefined,
    label: string,
    options?: { expanded?: boolean },
  ) {
    super(
      label,
      kind === 'root' || kind === 'directory'
        ? (options?.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = workspaceNodeId(uri);
    this.resourceUri = uri;
    this.tooltip = uri.scheme === 'file' ? uri.fsPath : uri.toString(true);

    // Files/folders: leave iconPath unset so the workbench file-icon theme
    // (VS Code default = Seti) paints them — same Seti source Desktop embeds.
    // Root / symlink still use the shared codicon ids for hosts without a theme entry.
    if (kind === 'root' || kind === 'symlink') {
      const icon = resolveWorkspaceTreeIcon({
        kind,
        name: label,
        expanded: options?.expanded,
      });
      this.iconPath = new vscode.ThemeIcon(icon.codicon);
    }

    if (kind === 'root') {
      this.contextValue = 'easyviewMd.workspaceRoot';
      return;
    }

    if (kind === 'directory') {
      this.contextValue = writable
        ? 'easyviewMd.workspaceDirectory'
        : 'easyviewMd.workspaceDirectoryReadonly';
      return;
    }

    if (kind === 'symlink') {
      this.contextValue = 'easyviewMd.workspaceSymlink';
      return;
    }

    this.contextValue = writable
      ? 'easyviewMd.workspaceFile'
      : 'easyviewMd.workspaceFileReadonly';
    this.command = {
      command: 'easyviewMd.workspace.openPreview',
      title: 'Open Preview',
      arguments: [this],
    };
  }
}

class WorkspaceTreeDataProvider implements vscode.TreeDataProvider<WorkspaceTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<WorkspaceTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly nodes = new Map<string, WorkspaceTreeNode>();
  private readonly children = new Map<string, WorkspaceTreeNode[]>();
  private rootFolder: vscode.WorkspaceFolder | undefined;

  constructor(private readonly treeService: WorkspaceTreeService) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  setRoot(rootFolder: vscode.WorkspaceFolder | undefined): boolean {
    const previous = this.rootFolder?.uri.toString(true);
    const next = rootFolder?.uri.toString(true);
    if (previous === next) return false;

    this.rootFolder = rootFolder;
    this.treeService.setRoot(rootFolder?.uri);
    this.nodes.clear();
    this.children.clear();
    this.changeEmitter.fire(undefined);
    return true;
  }

  async rename(relativePath: string, newName: string): Promise<VscodeWorkspaceEntry> {
    const root = this.rootFolder?.uri;
    if (!root) throw new Error('No active workspace root.');
    return this.treeService.rename(root, relativePath, newName);
  }

  async delete(relativePath: string): Promise<void> {
    const root = this.rootFolder?.uri;
    if (!root) throw new Error('No active workspace root.');
    await this.treeService.delete(root, relativePath);
  }

  async copy(sourceRelativePath: string, targetParentRelativePath: string): Promise<VscodeWorkspaceEntry> {
    const root = this.rootFolder?.uri;
    if (!root) throw new Error('No active workspace root.');
    return this.treeService.copy(root, sourceRelativePath, targetParentRelativePath);
  }

  async create(parentRelativePath: string, name: string, kind: 'file' | 'directory'): Promise<VscodeWorkspaceEntry> {
    const root = this.rootFolder?.uri;
    if (!root) throw new Error('No active workspace root.');
    return this.treeService.create(root, { parentRelativePath, name, kind });
  }

  getRootUri(): vscode.Uri | undefined {
    return this.rootFolder?.uri;
  }

  getRootName(): string | undefined {
    return this.rootFolder?.name;
  }

  getTreeItem(element: WorkspaceTreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: WorkspaceTreeNode): WorkspaceTreeNode | undefined {
    return element.parentId ? this.nodes.get(element.parentId) : undefined;
  }

  async getChildren(element?: WorkspaceTreeNode): Promise<WorkspaceTreeNode[]> {
    const rootFolder = this.rootFolder;
    if (!rootFolder) return [];

    // Explorer-style: the view title owns the workspace name; top-level rows are root children.
    if (!element) {
      return this.loadChildren(rootFolder, '', undefined);
    }
    if (element.kind !== 'root' && element.kind !== 'directory') return [];

    const cached = this.children.get(element.id);
    if (cached) return cached;
    return this.loadChildren(rootFolder, element.relativePath, element.id);
  }

  private async loadChildren(
    rootFolder: vscode.WorkspaceFolder,
    relativePath: string,
    parentId: string | undefined,
  ): Promise<WorkspaceTreeNode[]> {
    const cacheKey = parentId ?? workspaceNodeId(rootFolder.uri);
    const cached = this.children.get(cacheKey);
    if (cached) return cached;

    try {
      const entries = await this.treeService.readChildren(rootFolder.uri, relativePath);
      const result = entries.map((entry) => this.getOrCreateEntry(entry, parentId));
      this.children.set(cacheKey, result);
      return result;
    } catch (error) {
      const label = relativePath ? path.posix.basename(relativePath) : rootFolder.name;
      void vscode.window.showErrorMessage(`Unable to read ${label}: ${errorMessage(error)}`);
      return [];
    }
  }

  relativePath(resource: vscode.Uri): string | undefined {
    const root = this.rootFolder?.uri;
    return root ? workspaceRelativePath(root, resource) : undefined;
  }

  ensureFileChain(resource: vscode.Uri): WorkspaceTreeNode[] {
    const rootFolder = this.rootFolder;
    if (!rootFolder) return [];
    const relativePath = workspaceRelativePath(rootFolder.uri, resource);
    if (!relativePath) return [];

    const segments = relativePath.split('/');
    const chain: WorkspaceTreeNode[] = [];
    let parentId: string | undefined;
    let currentUri = rootFolder.uri;

    segments.forEach((segment, index) => {
      currentUri = vscode.Uri.joinPath(currentUri, segment);
      const isFile = index === segments.length - 1;
      const node = this.getOrCreateNode(
        currentUri,
        isFile ? 'file' : 'directory',
        segments.slice(0, index + 1).join('/'),
        vscode.workspace.fs.isWritableFileSystem(currentUri.scheme) !== false,
        parentId,
        segment,
      );
      chain.push(node);
      parentId = node.id;
    });

    return chain;
  }

  refreshAll(): void {
    this.treeService.invalidateAll(this.rootFolder?.uri);
    this.children.clear();
    this.changeEmitter.fire(undefined);
  }

  refreshResource(resource: vscode.Uri): void {
    const root = this.rootFolder?.uri;
    const relativePath = root ? workspaceRelativePath(root, resource) : undefined;
    if (root && relativePath !== undefined) this.treeService.invalidate(root, [relativePath]);

    const resourceId = workspaceNodeId(resource);
    const resourceNode = this.nodes.get(resourceId);
    if (resourceNode) this.changeEmitter.fire(resourceNode);

    if (!root) return;

    const parentRelativePath = relativePath === undefined
      ? undefined
      : relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : '';
    if (parentRelativePath === '') {
      this.children.delete(workspaceNodeId(root));
      this.removeCachedDescendants(resource);
      this.changeEmitter.fire(undefined);
      return;
    }

    const parentUri = workspaceParentUri(resource);
    const parent = this.nodes.get(workspaceNodeId(parentUri));
    if (parent) {
      this.children.delete(parent.id);
      this.removeCachedDescendants(resource);
      this.changeEmitter.fire(parent);
    }
  }

  private removeCachedDescendants(resource: vscode.Uri): void {
    const prefix = `${resource.toString(true).replace(/\/$/, '')}/`;
    for (const [id, node] of this.nodes) {
      if (node.uri.toString(true) === resource.toString(true) || node.uri.toString(true).startsWith(prefix)) {
        this.nodes.delete(id);
        this.children.delete(id);
      }
    }
  }

  private getOrCreateEntry(entry: VscodeWorkspaceEntry, parentId: string | undefined): WorkspaceTreeNode {
    return this.getOrCreateNode(
      entry.uri,
      entry.kind,
      entry.relativePath,
      entry.writable,
      parentId,
      entry.name,
    );
  }

  private getOrCreateNode(
    uri: vscode.Uri,
    kind: WorkspaceTreeNodeKind,
    relativePath: string,
    writable: boolean,
    parentId: string | undefined,
    label: string,
  ): WorkspaceTreeNode {
    const id = workspaceNodeId(uri);
    const existing = this.nodes.get(id);
    if (existing && existing.kind === kind && existing.parentId === parentId) return existing;

    const node = new WorkspaceTreeNode(uri, kind, relativePath, writable, parentId, label);
    this.nodes.set(id, node);
    return node;
  }
}

export function registerWorkspaceExplorer(): vscode.Disposable {
  const provider = new WorkspaceTreeDataProvider(new WorkspaceTreeService());
  const tree = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
  });

  let selectedEntries: WorkspaceTreeNode[] = [];
  let selectedEntry: WorkspaceTreeNode | undefined;
  let entryClipboard: { rootUri: string; relativePath: string } | null = null;
  let watcher: vscode.FileSystemWatcher | undefined;
  let revealTimer: NodeJS.Timeout | undefined;
  const pendingFileEvents = new Map<string, vscode.Uri>();
  let fileEventTimer: NodeJS.Timeout | undefined;
  const startupFocusTimer = scheduleFocusWorkspacePanelOnStartup();

  const updateSelectionContext = async (): Promise<void> => {
    const entrySelected = Boolean(
      selectedEntry && selectedEntry.kind !== 'root' && selectedEntry.relativePath,
    );
    await vscode.commands.executeCommand(
      'setContext',
      'easyviewMd.workspaceFiles.entrySelected',
      entrySelected,
    );
    await vscode.commands.executeCommand(
      'setContext',
      'easyviewMd.workspaceFiles.fileSelected',
      Boolean(selectedEntry && selectedEntry.kind === 'file'),
    );
  };

  const updateClipboardContext = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'setContext',
      'easyviewMd.workspaceFiles.hasClipboard',
      entryClipboard !== null,
    );
  };

  const queueFileEvent = (uri: vscode.Uri): void => {
    pendingFileEvents.set(uri.toString(true), uri);
    if (fileEventTimer) clearTimeout(fileEventTimer);
    fileEventTimer = setTimeout(() => {
      fileEventTimer = undefined;
      const resources = [...pendingFileEvents.values()];
      pendingFileEvents.clear();
      for (const resource of resources) provider.refreshResource(resource);
      void revealCurrentFile(false);
    }, 80);
  };

  const replaceWatcher = (rootFolder: vscode.WorkspaceFolder | undefined): void => {
    watcher?.dispose();
    watcher = undefined;
    if (!rootFolder) return;

    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootFolder.uri, '**/*'),
    );
    watcher.onDidCreate(queueFileEvent);
    watcher.onDidChange(queueFileEvent);
    watcher.onDidDelete(queueFileEvent);
  };

  const updateRoot = (): boolean => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const activeResource = resolveActiveResourceUri();
    const rootFolder = folders.length === 1
      ? folders[0]
      : activeResource
        ? vscode.workspace.getWorkspaceFolder(activeResource)
        : undefined;
    const changed = provider.setRoot(rootFolder);
    if (changed) replaceWatcher(rootFolder);

    tree.title = rootFolder?.name || 'Files';

    if (folders.length === 0) {
      tree.message = 'Open a folder or workspace to browse files.';
    } else if (folders.length > 1 && !rootFolder) {
      tree.message = 'Open an editor from a workspace folder to choose the active root.';
    } else {
      tree.message = undefined;
    }
    return changed;
  };

  const revealCurrentFile = async (focus: boolean): Promise<void> => {
    if (!tree.visible) return;
    const resource = resolveActiveResourceUri();
    if (!resource || !provider.relativePath(resource)) return;

    const chain = provider.ensureFileChain(resource);
    if (chain.length === 0) return;

    try {
      for (const ancestor of chain.slice(0, -1)) {
        await tree.reveal(ancestor, { expand: true, focus: false, select: false });
      }
      await tree.reveal(chain[chain.length - 1], { focus, select: true });
    } catch {
      // The active editor or workspace root may change while reveal is resolving.
    }
  };

  const resolveCreateParentRelativePath = (): string => {
    if (!selectedEntry || selectedEntry.kind === 'root') return '';
    if (selectedEntry.kind === 'directory') return selectedEntry.relativePath;
    const parent = path.posix.dirname(selectedEntry.relativePath);
    return parent === '.' ? '' : parent;
  };

  const createWorkspaceEntry = async (kind: 'file' | 'directory'): Promise<void> => {
    const rootUri = provider.getRootUri();
    if (!rootUri) {
      void vscode.window.showInformationMessage('Open a folder or workspace to create files.');
      return;
    }
    if (vscode.workspace.fs.isWritableFileSystem(rootUri.scheme) === false) {
      void vscode.window.showErrorMessage('The active workspace root is read-only.');
      return;
    }

    const parentRelativePath = resolveCreateParentRelativePath();
    const parentUri = parentRelativePath
      ? vscode.Uri.joinPath(rootUri, ...parentRelativePath.split('/'))
      : rootUri;
    const name = await uniqueWorkspaceCreateName(parentUri, kind);
    const created = await provider.create(parentRelativePath, name, kind);
    provider.refreshResource(parentUri);
    provider.refreshResource(created.uri);

    const chain = provider.ensureFileChain(created.uri);
    const createdNode = chain[chain.length - 1];
    if (createdNode) {
      try {
        for (const ancestor of chain.slice(0, -1)) {
          await tree.reveal(ancestor, { expand: true, focus: false, select: false });
        }
        await tree.reveal(createdNode, { focus: true, select: true });
      } catch {
        // Ignore transient reveal races after create.
      }
    }

    if (kind === 'file') {
      await vscode.commands.executeCommand('vscode.open', created.uri, { preview: false });
    }
  };

  const scheduleActiveContextUpdate = (): void => {
    updateRoot();
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      revealTimer = undefined;
      void revealCurrentFile(false);
    }, 50);
  };

  const selectedNode = (
    candidate: unknown | undefined,
    kinds: readonly WorkspaceTreeNodeKind[],
  ): WorkspaceTreeNode | undefined => {
    if (candidate instanceof WorkspaceTreeNode && kinds.includes(candidate.kind) && candidate.kind !== 'root') {
      return candidate;
    }
    return selectedEntry && kinds.includes(selectedEntry.kind) && selectedEntry.kind !== 'root'
      ? selectedEntry
      : undefined;
  };

  const withEntryNode = (
    kinds: readonly WorkspaceTreeNodeKind[],
    action: (node: WorkspaceTreeNode) => Promise<void>,
  ) => async (candidate?: unknown): Promise<void> => {
    const node = selectedNode(candidate, kinds);
    if (!node) return;
    try {
      await action(node);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  };

  const fileOrSymlink: WorkspaceTreeNodeKind[] = ['file', 'symlink'];
  const entryKinds: WorkspaceTreeNodeKind[] = ['file', 'directory', 'symlink'];
  const writableEntryKinds: WorkspaceTreeNodeKind[] = ['file', 'directory'];

  const disposables: vscode.Disposable[] = [
    provider,
    tree,
    tree.onDidChangeSelection((event) => {
      selectedEntries = event.selection.filter((node) => node.kind !== 'root');
      selectedEntry = selectedEntries[selectedEntries.length - 1];
      void updateSelectionContext();
    }),
    tree.onDidChangeVisibility((event) => {
      if (event.visible) {
        scheduleActiveContextUpdate();
      } else {
        selectedEntries = [];
        selectedEntry = undefined;
        void updateSelectionContext();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleActiveContextUpdate),
    vscode.window.onDidChangeActiveTextEditor(scheduleActiveContextUpdate),
    vscode.window.tabGroups.onDidChangeTabs(scheduleActiveContextUpdate),
    vscode.window.tabGroups.onDidChangeTabGroups(scheduleActiveContextUpdate),
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return;
      updateRoot();
      provider.refreshAll();
      void revealCurrentFile(false);
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.refresh', () => {
      updateRoot();
      provider.refreshAll();
    }),
    vscode.commands.registerCommand('easyviewMd.workspace.newFile', () => createWorkspaceEntry('file')),
    vscode.commands.registerCommand('easyviewMd.workspace.newFolder', () => createWorkspaceEntry('directory')),
    vscode.commands.registerCommand('easyviewMd.workspace.revealCurrentFile', () => revealCurrentFile(true)),
    vscode.commands.registerCommand('easyviewMd.workspace.openPreview', withEntryNode(fileOrSymlink, async (node) => {
      if (MARKDOWN_EXTENSION.test(node.uri.path)) {
        await vscode.commands.executeCommand('easyviewMd.openEditor', node.uri);
        return;
      }
      const route = resolvePreviewRoute(workspaceBasename(node.uri));
      if (route && isPhase1PreviewRoute(route.route)) {
        await vscode.commands.executeCommand('vscode.openWith', node.uri, 'easyviewMd.filePreview', { preview: true });
        return;
      }
      await vscode.commands.executeCommand('vscode.open', node.uri, { preview: true });
    })),
    vscode.commands.registerCommand('easyviewMd.workspace.openExternal', withEntryNode(fileOrSymlink, async (node) => {
      if (node.uri.scheme !== 'file') return;
      const opened = await vscode.env.openExternal(node.uri);
      if (!opened) throw new Error(`Unable to open ${workspaceBasename(node.uri)} with the default application.`);
    })),
    ...['easyviewMd.workspace.revealMac', 'easyviewMd.workspace.revealWindows', 'easyviewMd.workspace.revealLinux']
      .map((command) => vscode.commands.registerCommand(command, withEntryNode(entryKinds, async (node) => {
        if (node.uri.scheme !== 'file') return;
        await vscode.commands.executeCommand('revealFileInOS', node.uri);
      }))),
    vscode.commands.registerCommand('easyviewMd.workspace.copyResourceUri', withEntryNode(entryKinds, async (node) => {
      const rootUri = provider.getRootUri()?.toString(true);
      if (!rootUri || !node.relativePath) return;
      entryClipboard = { rootUri, relativePath: node.relativePath };
      await updateClipboardContext();
      await vscode.env.clipboard.writeText(
        node.uri.scheme === 'file' ? node.uri.fsPath : node.uri.toString(true),
      );
    })),
    vscode.commands.registerCommand('easyviewMd.workspace.paste', withEntryNode(entryKinds, async (node) => {
      if (!entryClipboard) return;
      const rootUri = provider.getRootUri()?.toString(true);
      if (!rootUri || entryClipboard.rootUri !== rootUri) {
        throw new Error('Clipboard entry belongs to another workspace root.');
      }
      const targetParentRelativePath = node.kind === 'directory'
        ? node.relativePath
        : path.posix.dirname(node.relativePath) === '.'
          ? ''
          : path.posix.dirname(node.relativePath);
      const pasted = await provider.copy(entryClipboard.relativePath, targetParentRelativePath);
      provider.refreshResource(node.kind === 'directory' ? node.uri : workspaceParentUri(node.uri));
      provider.refreshResource(pasted.uri);
    })),
    vscode.commands.registerCommand('easyviewMd.workspace.copyPath', withEntryNode(entryKinds, async (node) => {
      await vscode.env.clipboard.writeText(
        node.uri.scheme === 'file' ? node.uri.fsPath : node.uri.toString(true),
      );
    })),
    vscode.commands.registerCommand('easyviewMd.workspace.copyRelativePath', withEntryNode(entryKinds, async (node) => {
      const relativePath = provider.relativePath(node.uri);
      if (relativePath === undefined) return;
      await vscode.env.clipboard.writeText(relativePath);
    })),
    vscode.commands.registerCommand('easyviewMd.workspace.rename', withEntryNode(writableEntryKinds, async (node) => {
      if (!node.writable || !node.relativePath) return;
      const currentName = workspaceBasename(node.uri);
      const extension = node.kind === 'directory' ? '' : path.posix.extname(currentName);
      const nextName = await vscode.window.showInputBox({
        title: node.kind === 'directory' ? 'Rename Folder' : 'Rename File',
        prompt: node.kind === 'directory' ? 'Enter a new folder name.' : 'Enter a new file name.',
        value: currentName,
        valueSelection: [0, Math.max(0, currentName.length - extension.length)],
        validateInput: validateWorkspaceEntryName,
      });
      if (!nextName || nextName === currentName) return;

      const renamed = await provider.rename(node.relativePath, nextName);
      provider.refreshResource(node.uri);
      provider.refreshResource(renamed.uri);
    })),
    vscode.commands.registerCommand('easyviewMd.workspace.delete', async (candidate?: unknown) => {
      const nodes = (() => {
        if (candidate instanceof WorkspaceTreeNode) {
          return writableEntryKinds.includes(candidate.kind) && candidate.writable
            ? [candidate]
            : [];
        }
        return selectedEntries.filter(
          (node) => writableEntryKinds.includes(node.kind) && node.writable && node.relativePath,
        );
      })();
      if (nodes.length === 0) return;

      const label = nodes.length === 1
        ? `“${workspaceBasename(nodes[0].uri)}”`
        : `${nodes.length} selected items`;
      const confirmation = await vscode.window.showWarningMessage(
        `Delete ${label}? Items will be moved to the Trash when available.`,
        { modal: true },
        'Move to Trash',
      );
      if (confirmation !== 'Move to Trash') return;

      try {
        for (const node of nodes) {
          if (!node.relativePath) continue;
          await provider.delete(node.relativePath);
          provider.refreshResource(node.uri);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
      }
    }),
  ];

  updateRoot();
  void updateSelectionContext();
  void updateClipboardContext();

  const disposable = vscode.Disposable.from(...disposables, {
    dispose: () => {
      watcher?.dispose();
      if (revealTimer) clearTimeout(revealTimer);
      if (fileEventTimer) clearTimeout(fileEventTimer);
      if (startupFocusTimer) clearTimeout(startupFocusTimer);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.fileSelected', false);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.entrySelected', false);
      void vscode.commands.executeCommand('setContext', 'easyviewMd.workspaceFiles.hasClipboard', false);
    },
  });
  return disposable;
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

function workspaceNodeId(uri: vscode.Uri): string {
  return `easyviewMd.workspace:${uri.toString(true)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
