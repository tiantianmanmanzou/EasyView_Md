import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  convertWordToMarkdown,
  flattenPngWithWhiteBackground,
  rewriteExtractedMediaPaths,
} from '@easyview/node-runtime';
import { openMarkdownInEasyViewEditor } from './openMarkdownEditor';

export { flattenPngWithWhiteBackground, rewriteExtractedMediaPaths };

async function convertWithOverwritePrompt(sourcePath: string) {
  try {
    return await convertWordToMarkdown({ sourcePath, overwrite: false });
  } catch (error: any) {
    if (error?.code !== 'OUTPUT_EXISTS') throw error;
    const outputPath = path.join(
      path.dirname(sourcePath),
      `${path.basename(sourcePath, path.extname(sourcePath))}.md`,
    );
    const selection = await vscode.window.showWarningMessage(
      `${path.basename(outputPath)} already exists. Replace it?`,
      { modal: true },
      'Replace',
    );
    if (selection !== 'Replace') return null;
    return convertWordToMarkdown({ sourcePath, overwrite: true });
  }
}

export function registerWordToMarkdownCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('easyviewMd.convertWordToMarkdown', async (uri?: vscode.Uri) => {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || targetUri.scheme !== 'file') {
      vscode.window.showErrorMessage('Select a DOCX or DOC file first.');
      return;
    }

    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Converting Word document to Markdown',
          cancellable: false,
        },
        () => convertWithOverwritePrompt(targetUri.fsPath),
      );
      if (!result) return;
      const outputUri = vscode.Uri.file(result.outputPath);
      const selection = await vscode.window.showInformationMessage(
        `Converted to ${path.basename(result.outputPath)}`,
        'Open Markdown',
      );
      if (selection === 'Open Markdown') {
        await openMarkdownInEasyViewEditor(outputUri, context);
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`Word to Markdown conversion failed: ${error?.message || String(error)}`);
    }
  });
}
