import * as vscode from 'vscode';
import { stageFile as stageGitFile } from '@easyview/node-runtime';
import * as path from 'path';
import { NativeMarkdownDecorator } from '../native-editor/nativeDecorations';
import { MarkdownEditorProvider } from '../adapters/vscode/provider';
import { ensureNativeMarkdownEditorFont } from '../native-editor/nativeEditorFont';
import { NativeMermaidRenderer } from '../native-editor/nativeMermaidRenderer';
import { suppressConflictingMarkdownInlineDecorations } from '../native-editor/conflictingExtensions';
import { setPendingCursorForUri } from '../application/document/openCursorContext';
import { setPendingDocumentContentForUri } from '../application/document/openDocumentSnapshot';
import { logOpenWithDebug } from '../application/document/openWithDebug';
import { registerNativeMarkdownImagePaste } from '../native-editor/nativeImagePaste';
import { suppressNativeOutlineRestore } from '../native-editor/nativeOutlineNavigation';
import { registerWordToMarkdownCommand } from '../application/document/wordToMarkdown';
import { registerPdfToMarkdownCommand } from '../application/document/pdfToMarkdown';
import { getInstalledExtensionVersion, notifyExtensionUpdated } from './extensionUpdateNotification';
import { registerWorkspaceExplorer } from '../workspace/workspaceExplorer';
import { FilePreviewProvider } from '../preview/filePreviewProvider';
import { cycleProductTheme } from '../theme/productThemeBridge';


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
  const installedVersion = getInstalledExtensionVersion();
  if (installedVersion) {
    void notifyExtensionUpdated(context, installedVersion);
  }
  const mermaidRenderer = NativeMermaidRenderer.register(context);
  context.subscriptions.push(NativeMarkdownDecorator.register(context, mermaidRenderer));
  context.subscriptions.push(MarkdownEditorProvider.register(context));
  context.subscriptions.push(FilePreviewProvider.register(context));
  context.subscriptions.push(registerNativeMarkdownImagePaste());
  context.subscriptions.push(registerWordToMarkdownCommand());
  context.subscriptions.push(registerPdfToMarkdownCommand());
  context.subscriptions.push(registerWorkspaceExplorer());
  context.subscriptions.push(
    vscode.commands.registerCommand('easyviewMd.cycleProductTheme', async () => {
      const mode = await cycleProductTheme(context);
      const labels = { light: '亮色', gray: '灰色', dark: '暗色' } as const;
      void vscode.window.setStatusBarMessage(`EasyView 主题：${labels[mode]}`, 2000);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('easyviewMd.openEditor', async (uri?: vscode.Uri) => {
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
        suppressNativeOutlineRestore();
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'easyviewMd.markdownEditor',
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
            'easyviewMd.revealCursorInEasyView',
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
    vscode.commands.registerCommand('easyviewMd.openNativeEditor', async (uri?: vscode.Uri) => {
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
    vscode.commands.registerCommand('easyviewMd.stageFile', async () => {
      const targetUri = resolveCurrentMarkdownUri();
      if (!targetUri || targetUri.scheme !== 'file') {
        if (!MarkdownEditorProvider.notifyActivePanel({
          type: 'stageFileFailed',
          message: 'Open a Markdown file first.',
        })) {
          vscode.window.showInformationMessage('Open a Markdown file first.');
        }
        return;
      }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
      const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(targetUri.fsPath);
      try {
        await stageGitFile(cwd, targetUri.fsPath);
        const successText = `Staged: ${path.basename(targetUri.fsPath)}`;
        if (!MarkdownEditorProvider.notifyActivePanel({
          type: 'stageFileCompleted',
          message: successText,
        })) {
          vscode.window.showInformationMessage(successText);
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        const failText = `Failed to stage file: ${messageText}`;
        if (!MarkdownEditorProvider.notifyActivePanel({
          type: 'stageFileFailed',
          message: failText,
        })) {
          vscode.window.showErrorMessage(failText);
        }
      }
    })
  );
}

export function deactivate() {}
