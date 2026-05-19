import * as vscode from 'vscode';
import { NativeMarkdownDecorator } from './nativeDecorations';
import { MarkdownEditorProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(NativeMarkdownDecorator.register(context));
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
    vscode.commands.registerCommand('inlineMd.openNativeEditor', (uri?: vscode.Uri) => {
      const activeEditor = vscode.window.activeTextEditor;
      const targetUri = uri ?? activeEditor?.document.uri;

      if (targetUri && /\.(md|markdown|mdx)$/i.test(targetUri.fsPath)) {
        return vscode.commands.executeCommand('vscode.open', targetUri, {
          preview: false,
        });
      }

      vscode.window.showInformationMessage('Select a Markdown file first.');
      return undefined;
    })
  );
}

export function deactivate() {}
