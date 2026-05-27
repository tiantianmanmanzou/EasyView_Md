import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { NativeMarkdownDecorator } from './nativeDecorations';
import { MarkdownEditorProvider } from './provider';
import { ensureNativeMarkdownEditorFont } from './nativeEditorFont';
import { NativeMermaidRenderer } from './nativeMermaidRenderer';
import { suppressConflictingMarkdownInlineDecorations } from './conflictingExtensions';
import { setPendingCursorForUri } from './openCursorContext';
import { registerNativeMarkdownImagePaste } from './nativeImagePaste';

function execGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function resolveCurrentMarkdownUri(): vscode.Uri | undefined {
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc && /\.(md|markdown|mdx)$/i.test(activeDoc.uri.fsPath)) {
    return activeDoc.uri;
  }

  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const tabInput = (activeTab as any)?.input;
  const uri = tabInput?.uri as vscode.Uri | undefined;
  if (uri && /\.(md|markdown|mdx)$/i.test(uri.fsPath)) {
    return uri;
  }
  return undefined;
}

async function migrateDefaultEditorLayoutState(context: vscode.ExtensionContext): Promise<void> {
  const migrationKey = 'mdpre-zalman.migrations.defaultEditorLayoutState.1.0.121';
  if (context.globalState.get<boolean>(migrationKey)) {
    return;
  }

  const staleKeys = context.workspaceState.keys().filter((key) =>
    key.startsWith('mdpre-zalman.editorSettings:'),
  );

  for (const key of staleKeys) {
    await context.workspaceState.update(key, undefined);
  }

  await context.globalState.update(migrationKey, true);
}

export function activate(context: vscode.ExtensionContext) {
  void migrateDefaultEditorLayoutState(context);
  const mermaidRenderer = NativeMermaidRenderer.register(context);
  context.subscriptions.push(NativeMarkdownDecorator.register(context, mermaidRenderer));
  context.subscriptions.push(MarkdownEditorProvider.register(context));
  context.subscriptions.push(registerNativeMarkdownImagePaste());

  context.subscriptions.push(
    vscode.commands.registerCommand('inlineMd.openEditor', async (uri?: vscode.Uri) => {
      const activeEditor = vscode.window.activeTextEditor;
      const targetUri = uri ?? activeEditor?.document.uri;

      if (targetUri && /\.(md|markdown|mdx)$/i.test(targetUri.fsPath)) {
        const sourceEditor = activeEditor?.document.uri.toString() === targetUri.toString()
          ? activeEditor
          : vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === targetUri.toString());
        const selection = sourceEditor?.selection.active;
        if (selection) {
          setPendingCursorForUri(targetUri, {
            line: selection.line,
            character: selection.character,
          });
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'inlineMd.markdownEditor'
        );
        if (selection) {
          await vscode.commands.executeCommand(
            'inlineMd.revealCursorInEasyView',
            targetUri,
            selection.line,
            selection.character
          );
        }
        return;
      }

      vscode.window.showInformationMessage('Select a Markdown file first.');
      return undefined;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('inlineMd.openNativeEditor', async (uri?: vscode.Uri) => {
      const activeEditor = vscode.window.activeTextEditor;
      const targetUri = uri ?? activeEditor?.document.uri;

      if (targetUri && /\.(md|markdown|mdx)$/i.test(targetUri.fsPath)) {
        const document = await vscode.workspace.openTextDocument(targetUri);
        await ensureNativeMarkdownEditorFont(document);
        const editor = await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: false,
        });
        await suppressConflictingMarkdownInlineDecorations(editor);
        return editor;
      }

      vscode.window.showInformationMessage('Select a Markdown file first.');
      return undefined;
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('inlineMd.stageFile', async () => {
      const targetUri = resolveCurrentMarkdownUri();
      if (!targetUri || targetUri.scheme !== 'file') {
        vscode.window.showInformationMessage('Open a Markdown file first.');
        return;
      }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
      const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(targetUri.fsPath);
      await execGit(['add', targetUri.fsPath], cwd);
      vscode.window.showInformationMessage(`Staged ${path.basename(targetUri.fsPath)}`);
    })
  );
}

export function deactivate() {}
