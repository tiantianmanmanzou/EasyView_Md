import * as vscode from 'vscode';
import { isMarkdownDocument, parseMarkdownDocument } from './markdownModel';

export class NativeMarkdownCodeLensProvider implements vscode.CodeLensProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new NativeMarkdownCodeLensProvider();
    const disposable = vscode.languages.registerCodeLensProvider(
      [{ language: 'markdown' }, { language: 'mdx' }],
      provider
    );
    context.subscriptions.push(disposable);
    return disposable;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isMarkdownDocument(document)) return [];

    const info = parseMarkdownDocument(document);
    const lenses: vscode.CodeLens[] = [];

    for (const heading of info.headings) {
      const range = new vscode.Range(heading.line, 0, heading.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: 'Copy anchor',
        command: 'inlineMd.copyHeadingAnchor',
        arguments: [document.uri, heading.line],
      }));
      lenses.push(new vscode.CodeLens(range, {
        title: 'Insert link',
        command: 'inlineMd.insertHeadingLink',
        arguments: [document.uri, heading.line],
      }));
    }

    if (info.headings.length > 0) {
      lenses.unshift(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: 'Insert TOC',
        command: 'inlineMd.insertToc',
        arguments: [document.uri],
      }));
    }

    return lenses;
  }
}
