import * as vscode from 'vscode';
import { isMarkdownDocument, parseMarkdownDocument } from './markdownModel';

export class NativeMarkdownHoverProvider implements vscode.HoverProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new NativeMarkdownHoverProvider();
    const disposable = vscode.languages.registerHoverProvider(
      [{ language: 'markdown' }, { language: 'mdx' }],
      provider
    );
    context.subscriptions.push(disposable);
    return disposable;
  }

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!isMarkdownDocument(document)) return undefined;

    const info = parseMarkdownDocument(document);
    const character = position.character;
    const link = [...info.links, ...info.images].find((item) =>
      item.line === position.line && character >= item.start && character <= item.end
    );

    if (link) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(link.isImage ? '**Image**\n\n' : '**Link**\n\n');
      markdown.appendCodeblock(link.target);
      markdown.isTrusted = true;
      return new vscode.Hover(markdown, new vscode.Range(link.line, link.start, link.line, link.end));
    }

    const task = info.tasks.find((item) => item.line === position.line);
    if (task) {
      return new vscode.Hover(task.checked ? 'Completed task' : 'Open task');
    }

    const table = info.tables.find((item) => item.line === position.line);
    if (table) {
      return new vscode.Hover(`Markdown table row, ${table.columns} columns`);
    }

    const heading = info.headings.find((item) => item.line === position.line);
    if (heading) {
      return new vscode.Hover(`Anchor: #${heading.anchor}`);
    }

    return undefined;
  }
}
