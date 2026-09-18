import * as path from 'path';
import * as vscode from 'vscode';
import { buildXlsxBuffer } from '@easyview/node-runtime';
import { downloadFile } from './providerExportHandler';
import { showExportCompletionNotification } from './exportCompletionNotification';
import type { EditorToHostMessage } from '@easyview/contracts/protocol';

type ExportMessage = Extract<EditorToHostMessage, { type: 'exportXlsx' | 'exportHtml' }>;

export interface WebviewExportHandlerContext {
  document: vscode.TextDocument;
  getFilename: () => string;
}

/**
 * Handles export commands that only need the current document and save dialog.
 * DOCX remains in the main handler until its markdown renderer is extracted separately.
 */
export async function handleWebviewExportMessage(
  ctx: WebviewExportHandlerContext,
  message: ExportMessage,
): Promise<boolean> {
  if (message.type === 'exportXlsx') {
    const payload = message.payload;
    const docDir = path.dirname(ctx.document.uri.fsPath);
    const defaultName = message.fileName || `table-${Date.now()}.xlsx`;
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(docDir, defaultName)),
      filters: { 'Excel Workbook': ['xlsx'] },
    });
    if (!saveUri) return true;

    try {
      const buffer = await buildXlsxBuffer(payload);
      await vscode.workspace.fs.writeFile(saveUri, buffer);
      showExportCompletionNotification(
        `Excel exported to ${path.basename(saveUri.fsPath)}`,
        saveUri.fsPath,
        'Open File',
      );
    } catch (error: unknown) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (messageText.includes('EBUSY') || messageText.includes('resource busy')) {
        vscode.window.showErrorMessage('Cannot save Excel: the file is open in another program. Close it and try again.');
      } else {
        vscode.window.showErrorMessage(`Excel export failed: ${messageText}`);
      }
    }
    return true;
  }

  const html = message.html;
  const exportImages = message.images;
  const docDir = path.dirname(ctx.document.uri.fsPath);
  const defaultName = ctx.getFilename();
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(docDir, `${defaultName}.html`)),
    filters: { HTML: ['html'] },
  });
  if (!saveUri) return true;

  try {
    if (exportImages.length === 0) {
      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf-8'));
      showExportCompletionNotification(
        `Exported to ${path.basename(saveUri.fsPath)}`,
        saveUri.fsPath,
        'Open in Browser',
      );
      return true;
    }

    const htmlFilename = path.basename(saveUri.fsPath);
    const folderName = path.basename(saveUri.fsPath, '.html');
    const parentDir = path.dirname(saveUri.fsPath);
    const exportDir = path.join(parentDir, folderName);
    const imagesDir = path.join(exportDir, 'images');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(exportDir));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

    const htmlPath = path.join(exportDir, htmlFilename);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(htmlPath), Buffer.from(html, 'utf-8'));

    let failCount = 0;
    for (const image of exportImages) {
      const destPath = path.join(imagesDir, image.exportFilename);
      try {
        if (image.isExternal) {
          const data = await downloadFile(image.originalSrc);
          await vscode.workspace.fs.writeFile(vscode.Uri.file(destPath), data);
        } else {
          let decodedSrc = image.originalSrc;
          try { decodedSrc = decodeURIComponent(image.originalSrc); } catch { /* use as-is */ }
          const srcPath = path.isAbsolute(decodedSrc) ? decodedSrc : path.resolve(docDir, decodedSrc);
          await vscode.workspace.fs.copy(vscode.Uri.file(srcPath), vscode.Uri.file(destPath), { overwrite: true });
        }
      } catch (error) {
        console.error(`Failed to export image: ${image.originalSrc}`, error);
        failCount++;
      }
    }

    const failMessage = failCount > 0 ? ` (${failCount} image(s) failed)` : '';
    showExportCompletionNotification(
      `Exported to ${folderName}/${htmlFilename}${failMessage}`,
      htmlPath,
      'Open in Browser',
    );
  } catch (error: unknown) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (messageText.includes('EBUSY') || messageText.includes('resource busy')) {
      vscode.window.showErrorMessage('Cannot save HTML: the file is open in another program. Close it and try again.');
    } else {
      vscode.window.showErrorMessage(`HTML export failed: ${messageText}`);
    }
  }
  return true;
}
