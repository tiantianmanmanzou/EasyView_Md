import * as vscode from 'vscode';

const pendingContentByUri = new Map<string, string>();

export function setPendingDocumentContentForUri(uri: vscode.Uri, content: string): void {
  pendingContentByUri.set(uri.toString(), content);
}

export function consumePendingDocumentContentForUri(uri: vscode.Uri): string | undefined {
  const key = uri.toString();
  const content = pendingContentByUri.get(key);
  if (content !== undefined) {
    pendingContentByUri.delete(key);
  }
  return content;
}
