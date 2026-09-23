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
import { registerEasyViewMarkdownFileSystem } from '../application/document/markdownFileSystem';
import {
  openMarkdownInEasyViewEditor,
  rematerializeFileSchemeEasyViewMarkdownTabs,
  resolveMarkdownDiskUri,
} from '../application/document/openMarkdownEditor';
import {
  isDiskBackedMarkdownUri,
  sameMarkdownResource,
  toDiskFileUri,
  toEasyViewMarkdownUri,
} from '../application/document/markdownUri';

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

function registerMirrorSavePropagation(): vscode.Disposable {
  return vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!/\.(md|markdown|mdx)$/i.test(document.uri.fsPath)) return;
    const diskUri = resolveMarkdownDiskUri(document.uri);
    if (sameMarkdownResource(diskUri, document.uri)) return;
    try {
      await vscode.workspace.fs.writeFile(diskUri, Buffer.from(document.getText(), 'utf8'));
      logOpenWithDebug('openMarkdown.mirrorSavedToDisk', {
        mirror: document.uri.fsPath,
        disk: diskUri.fsPath,
      });
    } catch (error) {
      logOpenWithDebug('openMarkdown.mirrorSaveFailed', {
        mirror: document.uri.fsPath,
        disk: diskUri.fsPath,
        message: error instanceof Error ? error.message : String(error),
      });
      void vscode.window.showErrorMessage(
        `EasyView 镜像已保存，但写回原文件失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  void migrateDefaultEditorLayoutState(context);
  const installedVersion = getInstalledExtensionVersion();
  if (installedVersion) {
    void notifyExtensionUpdated(context, installedVersion);
  }

  // Must register before markdown CustomTextEditor opens easyviewMd: URIs.
  context.subscriptions.push(registerEasyViewMarkdownFileSystem());
  context.subscriptions.push(registerMirrorSavePropagation());

  const mermaidRenderer = NativeMermaidRenderer.register(context);
  context.subscriptions.push(NativeMarkdownDecorator.register(context, mermaidRenderer));
  context.subscriptions.push(MarkdownEditorProvider.register(context));
  context.subscriptions.push(FilePreviewProvider.register(context));
  context.subscriptions.push(registerNativeMarkdownImagePaste());
  context.subscriptions.push(registerWordToMarkdownCommand(context));
  context.subscriptions.push(registerPdfToMarkdownCommand(context));
  context.subscriptions.push(registerWorkspaceExplorer(context));
  void rematerializeFileSchemeEasyViewMarkdownTabs(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('easyviewMd.showEditorDiagnostics', () => {
      const editorDiagnostics = MarkdownEditorProvider.getDiagnostics();
      const previewDiagnostics = FilePreviewProvider.getDiagnostics();
      const output = vscode.window.createOutputChannel('EasyView_Md Diagnostics');
      output.clear();
      output.appendLine('EasyView_Md Editor Diagnostics');
      output.appendLine(`Generated: ${new Date().toISOString()}`);
      output.appendLine(JSON.stringify({ ...editorDiagnostics, ...previewDiagnostics }, null, 2));
      output.show(true);
    }),
  );

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
      const rawTargetUri = uri ?? activeEditor?.document.uri;

      if (rawTargetUri && /\.(md|markdown|mdx)$/i.test(rawTargetUri.fsPath)) {
        const diskUri = toDiskFileUri(
          rawTargetUri.scheme === 'file' || isDiskBackedMarkdownUri(rawTargetUri)
            ? (rawTargetUri.scheme === 'file' ? vscode.Uri.file(rawTargetUri.fsPath) : rawTargetUri)
            : vscode.Uri.file(rawTargetUri.fsPath),
        );
        const schemeUri = toEasyViewMarkdownUri(diskUri);
        const hadExistingPanels =
          MarkdownEditorProvider.hasPanelsForDocument(schemeUri)
          || MarkdownEditorProvider.hasPanelsForDocument(diskUri);

        const sourceEditor = activeEditor && (
          sameMarkdownResource(activeEditor.document.uri, diskUri)
          || sameMarkdownResource(activeEditor.document.uri, schemeUri)
        )
          ? activeEditor
          : vscode.window.visibleTextEditors.find((editor) =>
            sameMarkdownResource(editor.document.uri, diskUri)
            || sameMarkdownResource(editor.document.uri, schemeUri)
          );

        const selection = sourceEditor?.selection.active;
        if (selection) {
          setPendingCursorForUri(schemeUri, {
            line: selection.line,
            character: selection.character,
          });
          setPendingCursorForUri(diskUri, {
            line: selection.line,
            character: selection.character,
          });
        }
        if (sourceEditor) {
          const snapshot = sourceEditor.document.getText();
          setPendingDocumentContentForUri(schemeUri, snapshot);
          setPendingDocumentContentForUri(diskUri, snapshot);
          logOpenWithDebug('openEditor.snapshotCaptured', {
            path: diskUri.fsPath,
            snapshotLength: snapshot.length,
            isDirty: sourceEditor.document.isDirty,
          });
        }

        suppressNativeOutlineRestore();
        logOpenWithDebug('openEditor.executeOpenWith', {
          path: diskUri.fsPath,
          viewColumn: sourceEditor?.viewColumn ?? 'unknown',
        });

        let openUri: vscode.Uri;
        try {
          openUri = await openMarkdownInEasyViewEditor(
            diskUri,
            context,
            sourceEditor?.viewColumn,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logOpenWithDebug('openEditor.openFailed', {
            path: diskUri.fsPath,
            message,
          });
          void vscode.window.showErrorMessage(`EasyView 无法打开该 Markdown：${message}`);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
        if (
          !hadExistingPanels
          && !MarkdownEditorProvider.hasPanelsForDocument(openUri)
          && !MarkdownEditorProvider.hasPanelsForDocument(schemeUri)
          && !MarkdownEditorProvider.hasPanelsForDocument(diskUri)
        ) {
          logOpenWithDebug('openEditor.openWithNoPanel', {
            path: diskUri.fsPath,
            openUri: openUri.toString(true),
          });
          void vscode.window.showErrorMessage(
            'EasyView 未能打开该 Markdown（自定义编辑器未创建面板）。请查看 “EasyView_Md Open Debug” 输出。',
          );
          return;
        }

        const reloaded = hadExistingPanels
          ? await MarkdownEditorProvider.reloadPanelsForDocument(
            openUri,
            sourceEditor?.document.getText(),
          )
          : false;
        logOpenWithDebug('openEditor.reloadExistingPanels', {
          path: diskUri.fsPath,
          openUri: openUri.toString(true),
          hadExistingPanels,
          reloaded,
        });
        logOpenWithDebug('openEditor.openWithCompleted', {
          path: diskUri.fsPath,
          openUri: openUri.toString(true),
        });
        if (selection) {
          await vscode.commands.executeCommand(
            'easyviewMd.revealCursorInEasyView',
            openUri,
            selection.line,
            selection.character,
          );
        }
        return;
      }

      vscode.window.showInformationMessage('Select a Markdown file first.');
      logOpenWithDebug('openEditor.noMarkdownTarget');
      return undefined;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('easyviewMd.openNativeEditor', async (uri?: vscode.Uri) => {
      const activeEditor = vscode.window.activeTextEditor;
      const rawTargetUri = uri ?? activeEditor?.document.uri;

      if (rawTargetUri && /\.(md|markdown|mdx)$/i.test(rawTargetUri.fsPath)) {
        const diskUri = toDiskFileUri(
          rawTargetUri.scheme === 'file'
            ? vscode.Uri.file(rawTargetUri.fsPath)
            : rawTargetUri,
        );
        try {
          const document = await vscode.workspace.openTextDocument(diskUri);
          await ensureNativeMarkdownEditorFont(document);
          const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
          });
          await suppressConflictingMarkdownInlineDecorations(editor);
          return editor;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logOpenWithDebug('openNativeEditor.failed', {
            path: diskUri.fsPath,
            message,
          });
          // Workbench open does not require ext-host TextDocument sync.
          await vscode.commands.executeCommand('vscode.open', diskUri, { preview: false });
          return undefined;
        }
      }

      vscode.window.showInformationMessage('Select a Markdown file first.');
      return undefined;
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('easyviewMd.stageFile', async () => {
      const targetUri = resolveCurrentMarkdownUri();
      const diskUri = targetUri ? resolveMarkdownDiskUri(targetUri) : undefined;
      if (!diskUri || diskUri.scheme !== 'file') {
        if (!MarkdownEditorProvider.notifyActivePanel({
          type: 'stageFileFailed',
          message: 'Open a Markdown file first.',
        })) {
          vscode.window.showInformationMessage('Open a Markdown file first.');
        }
        return;
      }
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(diskUri);
      const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(diskUri.fsPath);
      try {
        await stageGitFile(cwd, diskUri.fsPath);
        const successText = `Staged: ${path.basename(diskUri.fsPath)}`;
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
    }),
  );
}

export function deactivate() {}
