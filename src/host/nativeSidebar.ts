import * as vscode from 'vscode';
import { computeGitLineRanges } from './gitChangeTracker';
import { isMarkdownDocument, parseMarkdownDocument } from './markdownModel';

type NodeKind = 'section' | 'heading' | 'task' | 'link' | 'image' | 'git';

class NativeMarkdownTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    public readonly uri?: vscode.Uri,
    public readonly line?: number,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = kind;
    this.iconPath = new vscode.ThemeIcon(NativeMarkdownTreeItem.iconFor(kind));
    if (uri && typeof line === 'number') {
      this.command = {
        command: 'inlineMd.revealLine',
        title: 'Reveal',
        arguments: [uri, line],
      };
    }
  }

  private static iconFor(kind: NodeKind): string {
    switch (kind) {
      case 'heading': return 'symbol-string';
      case 'task': return 'checklist';
      case 'link': return 'link';
      case 'image': return 'file-media';
      case 'git': return 'git-compare';
      default: return 'list-tree';
    }
  }
}

export class NativeMarkdownSidebarProvider implements vscode.TreeDataProvider<NativeMarkdownTreeItem>, vscode.Disposable {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new NativeMarkdownSidebarProvider();
    const tree = vscode.window.createTreeView('inlineMd.nativePanel', { treeDataProvider: provider });
    context.subscriptions.push(provider, tree);
    provider.initialize();
    return vscode.Disposable.from(provider, tree);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NativeMarkdownTreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private initialize(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isMarkdownDocument(event.document)) this.refresh();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (isMarkdownDocument(document)) this.refresh();
      }),
      vscode.commands.registerCommand('inlineMd.refreshNativePanel', () => this.refresh())
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: NativeMarkdownTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NativeMarkdownTreeItem): Promise<NativeMarkdownTreeItem[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isMarkdownDocument(editor.document)) {
      return [];
    }

    const uri = editor.document.uri;
    const info = parseMarkdownDocument(editor.document);

    if (!element) {
      return [
        new NativeMarkdownTreeItem(`Outline (${info.headings.length})`, 'section', undefined, undefined, vscode.TreeItemCollapsibleState.Expanded),
        new NativeMarkdownTreeItem(`Tasks (${info.tasks.length})`, 'section', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
        new NativeMarkdownTreeItem(`Links (${info.links.length})`, 'section', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
        new NativeMarkdownTreeItem(`Images (${info.images.length})`, 'section', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
        new NativeMarkdownTreeItem('Git Changes', 'section', undefined, undefined, vscode.TreeItemCollapsibleState.Collapsed),
      ];
    }

    if (element.label?.toString().startsWith('Outline')) {
      return info.headings.map((heading) =>
        new NativeMarkdownTreeItem(`${'#'.repeat(heading.level)} ${heading.text}`, 'heading', uri, heading.line)
      );
    }

    if (element.label?.toString().startsWith('Tasks')) {
      return info.tasks.map((task) =>
        new NativeMarkdownTreeItem(`${task.checked ? '[x]' : '[ ]'} ${task.text}`, 'task', uri, task.line)
      );
    }

    if (element.label?.toString().startsWith('Links')) {
      return info.links.map((link) =>
        new NativeMarkdownTreeItem(`${link.text} -> ${link.target}`, 'link', uri, link.line)
      );
    }

    if (element.label?.toString().startsWith('Images')) {
      return info.images.map((image) =>
        new NativeMarkdownTreeItem(`${image.text} -> ${image.target}`, 'image', uri, image.line)
      );
    }

    if (element.label?.toString() === 'Git Changes') {
      const ranges = await computeGitLineRanges(uri, editor.document.getText());
      return ranges.map((range) =>
        new NativeMarkdownTreeItem(`${range.kind}: ${range.startLine}-${range.endLine}`, 'git', uri, range.startLine - 1)
      );
    }

    return [];
  }
}
