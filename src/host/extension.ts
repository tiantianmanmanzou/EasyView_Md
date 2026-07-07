import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { NativeMarkdownDecorator } from './nativeDecorations';
import { MarkdownEditorProvider } from './provider';
import { ensureNativeMarkdownEditorFont } from './nativeEditorFont';
import { NativeMermaidRenderer } from './nativeMermaidRenderer';
import { suppressConflictingMarkdownInlineDecorations } from './conflictingExtensions';
import { setPendingCursorForUri } from './openCursorContext';
import { setPendingDocumentContentForUri } from './openDocumentSnapshot';
import { logOpenWithDebug } from './openWithDebug';
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
        const hadExistingPanels = MarkdownEditorProvider.hasPanelsForDocument(targetUri);
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
        if (sourceEditor) {
          const snapshot = sourceEditor.document.getText();
          setPendingDocumentContentForUri(targetUri, snapshot);
          logOpenWithDebug('openEditor.snapshotCaptured', {
            path: targetUri.fsPath,
            snapshotLength: snapshot.length,
            isDirty: sourceEditor.document.isDirty,
            visibleEditors: vscode.window.visibleTextEditors
              .filter((editor) => editor.document.uri.toString() === targetUri.toString())
              .length,
          });
        }
        logOpenWithDebug('openEditor.executeOpenWith', {
          path: targetUri.fsPath,
          viewColumn: sourceEditor?.viewColumn ?? 'unknown',
        });
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'inlineMd.markdownEditor',
          sourceEditor?.viewColumn
        );
        const reloaded = hadExistingPanels
          ? await MarkdownEditorProvider.reloadPanelsForDocument(
            targetUri,
            sourceEditor?.document.getText()
          )
          : false;
        logOpenWithDebug('openEditor.reloadExistingPanels', {
          path: targetUri.fsPath,
          hadExistingPanels,
          reloaded,
        });
        logOpenWithDebug('openEditor.openWithCompleted', {
          path: targetUri.fsPath,
        });
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
      logOpenWithDebug('openEditor.noMarkdownTarget');
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
