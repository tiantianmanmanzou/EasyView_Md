import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import MarkdownIt from 'markdown-it';
import { findChromiumBinary, printToPdf } from './providerExportHandler';
import { roundPdfCorners } from './pdfRoundCorners';
import { activeMarkdownEditor, isMarkdownDocument, parseMarkdownDocument } from './markdownModel';

function execGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function documentForUri(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri) return vscode.workspace.openTextDocument(uri);
  return activeMarkdownEditor()?.document;
}

async function editorForUri(uri?: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  const document = await documentForUri(uri);
  if (!document || !isMarkdownDocument(document)) return undefined;
  return vscode.window.showTextDocument(document, { preview: false });
}

function htmlTemplate(title: string, body: string, isDark: boolean): string {
  const background = isDark ? '#1e1e1e' : '#ffffff';
  const foreground = isDark ? '#d4d4d4' : '#24292f';
  const border = isDark ? '#3c3c3c' : '#d0d7de';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{max-width:920px;margin:32px auto;padding:0 24px;background:${background};color:${foreground};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.65}
pre,code{font-family:Menlo,Consolas,monospace}
pre{padding:16px;overflow:auto;background:rgba(127,127,127,.12);border-radius:6px}
code{background:rgba(127,127,127,.14);padding:.15em .35em;border-radius:4px}
blockquote{border-left:4px solid ${border};margin-left:0;padding-left:16px;color:inherit;opacity:.82}
table{border-collapse:collapse;width:100%;margin:16px 0}
th,td{border:1px solid ${border};padding:6px 10px}
img{max-width:100%}
a{color:#4da3ff}
</style>
</head>
<body>${body}</body>
</html>`;
}

async function renderMarkdownHtml(document: vscode.TextDocument, isDark: boolean): Promise<string> {
  const markdown = new MarkdownIt({ html: true, linkify: true, typographer: true });
  return htmlTemplate(path.basename(document.uri.fsPath), markdown.render(document.getText()), isDark);
}

async function exportHtml(isDark: boolean): Promise<void> {
  const document = activeMarkdownEditor()?.document;
  if (!document) {
    vscode.window.showInformationMessage('Open a Markdown file first.');
    return;
  }

  const defaultUri = vscode.Uri.file(path.join(
    path.dirname(document.uri.fsPath),
    `${path.basename(document.uri.fsPath, path.extname(document.uri.fsPath))}.html`
  ));
  const saveUri = await vscode.window.showSaveDialog({ defaultUri, filters: { HTML: ['html'] } });
  if (!saveUri) return;

  const html = await renderMarkdownHtml(document, isDark);
  await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf8'));
  vscode.window.showInformationMessage(`Exported HTML to ${path.basename(saveUri.fsPath)}`);
}

async function exportPdf(isDark: boolean): Promise<void> {
  const document = activeMarkdownEditor()?.document;
  if (!document) {
    vscode.window.showInformationMessage('Open a Markdown file first.');
    return;
  }

  const chrome = findChromiumBinary();
  if (!chrome) {
    vscode.window.showErrorMessage('PDF export needs Chrome, Edge, or Chromium installed.');
    return;
  }

  const baseName = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), `${baseName}.pdf`)),
    filters: { PDF: ['pdf'] },
  });
  if (!saveUri) return;

  const tempHtml = path.join(path.dirname(saveUri.fsPath), `.${baseName}.inline-md-export.html`);
  const tempPdf = path.join(path.dirname(saveUri.fsPath), `.${baseName}.inline-md-export.pdf`);
  try {
    await fs.writeFile(tempHtml, await renderMarkdownHtml(document, isDark), 'utf8');
    const result = await printToPdf(chrome, tempHtml, tempPdf);
    if (!result) throw new Error('Chromium did not create a PDF.');
    const rounded = await roundPdfCorners(await fs.readFile(tempPdf));
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(rounded));
    vscode.window.showInformationMessage(`Exported PDF to ${path.basename(saveUri.fsPath)}`);
  } finally {
    await fs.rm(tempHtml, { force: true });
    await fs.rm(tempPdf, { force: true });
  }
}

export function registerNativeMarkdownCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('inlineMd.openEditor', (uri?: vscode.Uri) =>
    vscode.commands.executeCommand('inlineMd.openNativeEditor', uri)
  ));

  disposables.push(vscode.commands.registerCommand('inlineMd.openNativeEditor', async (uri?: vscode.Uri) => {
    const editor = await editorForUri(uri);
    if (!editor) vscode.window.showInformationMessage('Open a Markdown file first.');
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.revealLine', async (uri: vscode.Uri, line: number) => {
    const editor = await editorForUri(uri);
    if (!editor) return;
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.copyHeadingAnchor', async (uri?: vscode.Uri, line?: number) => {
    const document = await documentForUri(uri);
    if (!document) return;
    const heading = parseMarkdownDocument(document).headings.find((item) => item.line === line);
    if (!heading) return;
    await vscode.env.clipboard.writeText(`#${heading.anchor}`);
    vscode.window.showInformationMessage(`Copied #${heading.anchor}`);
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.insertHeadingLink', async (uri?: vscode.Uri, line?: number) => {
    const editor = await editorForUri(uri);
    if (!editor) return;
    const heading = parseMarkdownDocument(editor.document).headings.find((item) => item.line === line);
    if (!heading) return;
    await editor.edit((edit) => edit.insert(editor.selection.active, `[${heading.text}](#${heading.anchor})`));
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.insertToc', async (uri?: vscode.Uri) => {
    const editor = await editorForUri(uri);
    if (!editor) return;
    const toc = parseMarkdownDocument(editor.document).headings
      .map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}- [${heading.text}](#${heading.anchor})`)
      .join('\n');
    if (!toc) return;
    await editor.edit((edit) => edit.insert(editor.selection.active, `${toc}\n\n`));
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.insertTable', async () => {
    const editor = activeMarkdownEditor();
    if (!editor) {
      vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }
    await editor.edit((edit) => edit.insert(editor.selection.active, '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n'));
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.insertImage', async () => {
    const editor = activeMarkdownEditor();
    if (!editor) {
      vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] },
      defaultUri: vscode.Uri.file(path.dirname(editor.document.uri.fsPath)),
    });
    const image = selected?.[0];
    if (!image) return;
    let relativePath = path.relative(path.dirname(editor.document.uri.fsPath), image.fsPath).replace(/\\/g, '/');
    if (!relativePath.startsWith('.')) relativePath = `./${relativePath}`;
    await editor.edit((edit) => edit.insert(editor.selection.active, `![${path.basename(image.fsPath, path.extname(image.fsPath))}](${relativePath})`));
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.renameFile', async () => {
    const document = activeMarkdownEditor()?.document;
    if (!document || document.uri.scheme !== 'file') {
      vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }
    const ext = path.extname(document.uri.fsPath);
    const current = path.basename(document.uri.fsPath, ext);
    const next = await vscode.window.showInputBox({ value: current, prompt: 'New file name' });
    if (!next || next === current) return;
    const nextUri = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), `${next}${ext}`));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(document.uri, nextUri);
    await vscode.workspace.applyEdit(edit);
    await editorForUri(nextUri);
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.stageFile', async () => {
    const document = activeMarkdownEditor()?.document;
    if (!document || document.uri.scheme !== 'file') {
      vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(document.uri.fsPath);
    await execGit(['add', document.uri.fsPath], cwd);
    vscode.window.showInformationMessage(`Staged ${path.basename(document.uri.fsPath)}`);
    vscode.commands.executeCommand('inlineMd.refreshNativePanel');
  }));

  disposables.push(vscode.commands.registerCommand('inlineMd.exportHtmlLight', () => exportHtml(false)));
  disposables.push(vscode.commands.registerCommand('inlineMd.exportHtmlDark', () => exportHtml(true)));
  disposables.push(vscode.commands.registerCommand('inlineMd.exportPdfLight', () => exportPdf(false)));
  disposables.push(vscode.commands.registerCommand('inlineMd.exportPdfDark', () => exportPdf(true)));

  const disposable = vscode.Disposable.from(...disposables);
  context.subscriptions.push(disposable);
  return disposable;
}
