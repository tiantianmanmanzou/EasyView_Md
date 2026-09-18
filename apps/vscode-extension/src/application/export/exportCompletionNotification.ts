import * as vscode from 'vscode';
import { openWithDefaultApp } from '../document/openWithDefaultApp';

/**
 * Show the post-export toast with an open action.
 *
 * Calling `showInformationMessage` immediately after `showSaveDialog` returns
 * (especially from an editor message handler) often fails to paint the toast.
 * Defer so the save-dialog teardown finishes first, and do not keep the
 * message-handler promise waiting on the toast click.
 */
export function showExportCompletionNotification(
  message: string,
  filePath: string,
  openActionLabel = 'Open File',
): void {
  setTimeout(() => {
    void vscode.window
      .showInformationMessage(message, openActionLabel)
      .then((action) => {
        if (action === openActionLabel) openWithDefaultApp(filePath);
      });
  }, 100);
}
