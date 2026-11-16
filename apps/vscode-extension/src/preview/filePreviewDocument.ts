import * as vscode from 'vscode';
import { isPreviewWritableFile } from '@easyview/contracts';

/**
 * Custom document for EasyView file preview. Writable routes report dirty via
 * webview `setDirty` so VS Code can prompt on close / quit / reload.
 */
export class FilePreviewDocument implements vscode.CustomDocument {
  private readonly onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FilePreviewDocument>>();
  readonly onDidChangeCustomDocument = this.onDidChange.event;
  private markedDirty = false;
  private panel: vscode.WebviewPanel | undefined;
  private reloader: (() => void) | undefined;
  private saveWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    this.onDidChange.dispose();
    for (const waiter of this.saveWaiters.values()) {
      waiter.reject(new Error('Document disposed'));
    }
    this.saveWaiters.clear();
  }

  setReloader(reloader: (() => void) | undefined): void {
    this.reloader = reloader;
  }

  get writable(): boolean {
    const name = this.uri.fsPath || this.uri.path;
    return isPreviewWritableFile(name.split(/[/\\]/).pop() ?? name);
  }

  attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
  }

  /** Webview reports unsaved edits — make the tab dirty (once until save/revert). */
  notifyDirty(dirty: boolean): void {
    if (!this.writable) return;
    if (dirty) {
      if (this.markedDirty) return;
      this.markedDirty = true;
      this.onDidChange.fire({
        document: this,
        label: 'Edit',
        undo: () => { this.markedDirty = false; },
        redo: () => { this.markedDirty = true; },
      });
      return;
    }
    this.markedDirty = false;
  }

  async saveFromHost(cancellation: vscode.CancellationToken): Promise<void> {
    if (!this.writable) return;
    const panel = this.panel;
    if (!panel) return;
    const id = `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await new Promise<void>((resolve, reject) => {
      if (cancellation.isCancellationRequested) {
        reject(new Error('Cancelled'));
        return;
      }
      const cancel = cancellation.onCancellationRequested(() => {
        this.saveWaiters.delete(id);
        cancel.dispose();
        reject(new Error('Cancelled'));
      });
      this.saveWaiters.set(id, {
        resolve: () => { this.markedDirty = false; cancel.dispose(); resolve(); },
        reject: (error) => { cancel.dispose(); reject(error); },
      });
      void panel.webview.postMessage({ type: 'hostSaveRequest', id });
    });
  }

  completeSave(id: string, ok: boolean, message?: string): void {
    const waiter = this.saveWaiters.get(id);
    if (!waiter) return;
    this.saveWaiters.delete(id);
    if (ok) waiter.resolve();
    else waiter.reject(new Error(message || 'Save failed'));
  }

  async revert(): Promise<void> {
    this.reloader?.();
    const panel = this.panel;
    if (!panel) return;
    await panel.webview.postMessage({ type: 'hostRevertRequest' });
  }
}
