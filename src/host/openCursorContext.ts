import * as vscode from 'vscode';

type PendingCursor = {
  line: number;
  character: number;
};

const pendingCursorByUri = new Map<string, PendingCursor>();

export function setPendingCursorForUri(uri: vscode.Uri, cursor: PendingCursor): void {
  pendingCursorByUri.set(uri.toString(), cursor);
}

export function consumePendingCursorForUri(uri: vscode.Uri): PendingCursor | undefined {
  const key = uri.toString();
  const cursor = pendingCursorByUri.get(key);
  if (cursor) {
    pendingCursorByUri.delete(key);
  }
  return cursor;
}

