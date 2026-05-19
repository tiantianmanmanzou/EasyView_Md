import * as vscode from 'vscode';
import { NativeMarkdownDecorator } from './nativeDecorations';
import { MarkdownEditorProvider } from './provider';
import { ensureNativeMarkdownEditorFont } from './nativeEditorFont';
import { NativeMermaidRenderer } from './nativeMermaidRenderer';
import { suppressConflictingMarkdownInlineDecorations } from './conflictingExtensions';

export function activate(context: vscode.ExtensionContext) {
  const mermaidRenderer = NativeMermaidRenderer.register(context);
  context.subscriptions.push(NativeMarkdownDecorator.register(context, mermaidRenderer));
  context.subscriptions.push(MarkdownEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('inlineMd.openEditor', (uri?: vscode.Uri) => {
      const activeEditor = vscode.window.activeTextEditor;
      const targetUri = uri ?? activeEditor?.document.uri;

      if (targetUri && /\.(md|markdown|mdx)$/i.test(targetUri.fsPath)) {
        return vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'inlineMd.markdownEditor'
        );
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
}

export function deactivate() {}
