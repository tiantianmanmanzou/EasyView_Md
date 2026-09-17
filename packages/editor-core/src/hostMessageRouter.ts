import type { HostToWebviewMessage } from '../shared/protocol';

export interface HostMessageSideEffectHandlers {
  onCommitMessageGenerated(message: string, source: string): void;
  onCommitMessageGenerationFailed(message: string): void;
  onCommitFileCompleted(message: string): void;
  onCommitFileFailed(message: string): void;
  onSyncFileCompleted(message: string): void;
  onSyncFileFailed(message: string): void;
  onClipboardCopyCompleted(message: string): void;
  onClipboardCopyFailed(message: string): void;
  onFocus(): void;
  onRevealCursor(line: number, totalLines?: number): void;
  onFileRenamed(fileName: string): void;
  onRequestExportHtml(theme: 'light' | 'dark'): void;
  onRequestExportPdf(theme: 'light' | 'dark'): void;
  onRequestExportDocx(): void;
  onImageSelected(message: Extract<HostToWebviewMessage, { type: 'imageSelected' }>): void;
  onImagesDropped(message: Extract<HostToWebviewMessage, { type: 'imagesDropped' }>): void;
}

/**
 * Routes Host messages whose behavior is independent of document synchronization.
 * Keeping this separate leaves the main editor switch responsible only for content
 * and Git state reconciliation.
 */
export function handleHostMessageSideEffect(
  message: HostToWebviewMessage,
  handlers: HostMessageSideEffectHandlers,
): boolean {
  switch (message.type) {
    case 'commitMessageGenerated':
      handlers.onCommitMessageGenerated(message.message, message.source || 'Generated');
      return true;
    case 'commitMessageGenerationFailed':
      handlers.onCommitMessageGenerationFailed(message.message || 'Failed to generate commit message.');
      return true;
    case 'commitFileCompleted':
      handlers.onCommitFileCompleted(message.message || 'Committed current file');
      return true;
    case 'commitFileFailed':
      handlers.onCommitFileFailed(message.message || 'Failed to commit current file.');
      return true;
    case 'syncFileCompleted':
      handlers.onSyncFileCompleted(message.message || 'Synced current file');
      return true;
    case 'syncFileFailed':
      handlers.onSyncFileFailed(message.message || 'Failed to sync current file.');
      return true;
    case 'clipboardCopyCompleted':
      handlers.onClipboardCopyCompleted(message.message || 'Copied');
      return true;
    case 'clipboardCopyFailed':
      handlers.onClipboardCopyFailed(message.message || 'Copy failed');
      return true;
    case 'focus':
      handlers.onFocus();
      return true;
    case 'revealCursor':
      handlers.onRevealCursor(message.line, message.totalLines);
      return true;
    case 'fileRenamed':
      handlers.onFileRenamed(message.fileName);
      return true;
    case 'requestExportHtml':
      handlers.onRequestExportHtml(message.theme || 'light');
      return true;
    case 'requestExportPdf':
      handlers.onRequestExportPdf(message.theme || 'light');
      return true;
    case 'requestExportDocx':
      handlers.onRequestExportDocx();
      return true;
    case 'imageSelected':
      handlers.onImageSelected(message);
      return true;
    case 'imagesDropped':
      handlers.onImagesDropped(message);
      return true;
    default:
      return false;
  }
}
