import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
  // Register custom text editor provider
  context.subscriptions.push(MarkdownEditorProvider.register(context));

  // Register command to open editor
  context.subscriptions.push(
    vscode.commands.registerCommand('inlineMd.openEditor', (uri?: vscode.Uri) => {
      const activeEditor = vscode.window.activeTextEditor;
      const targetUri = uri ?? activeEditor?.document.uri;

      if (targetUri && /\.(md|markdown|mdx)$/i.test(targetUri.fsPath)) {
        vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'inlineMd.markdownEditor'
        );
      } else {
        vscode.window.showInformationMessage('Select a Markdown file first.');
      }
    })
  );
}

export function deactivate() {}
