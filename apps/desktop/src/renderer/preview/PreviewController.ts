import type { ArchiveEntry, ArchiveEntryPreview, HttpPreviewRequest, HttpPreviewResponse, PreviewDescriptor, PreviewTextResult, PreviewWriteResult } from '@easyview/contracts';
import type { PreviewHost, PreviewState, PreviewStatus } from '@easyview/preview-ui';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';
import { tPreview } from './preview.i18n';

export type { PreviewState, PreviewStatus };

export class PreviewController implements PreviewHost {
  private state: PreviewState = { descriptor: null, status: 'idle', error: null };
  private activeRequest = 0;
  private readonly listeners = new Set<() => void>();
  private dirty = false;
  private saveHandler: (() => Promise<void>) | null = null;
  private relativePath: string | null = null;

  constructor(private readonly api: EasyViewDesktopApi) {}

  getState = (): PreviewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setDirty = (dirty: boolean): void => {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    const path = this.relativePath ?? this.state.descriptor?.relativePath;
    if (path) void this.api.preview.setDirty(path, dirty);
  };

  registerSaveHandler = (save: () => Promise<void>): (() => void) => {
    this.saveHandler = save;
    return () => {
      if (this.saveHandler === save) this.saveHandler = null;
    };
  };

  /** True when the open preview has unsaved edits. */
  isDirty(): boolean {
    return this.dirty;
  }

  matchesPath(relativePath: string): boolean {
    return this.relativePath === relativePath
      || this.state.descriptor?.relativePath === relativePath;
  }

  currentPath(): string | null {
    return this.relativePath ?? this.state.descriptor?.relativePath ?? null;
  }

  /** Persist via the active viewer; used by close-with-save prompts. */
  async save(): Promise<boolean> {
    if (!this.saveHandler) return !this.dirty;
    try {
      await this.saveHandler();
      return !this.dirty;
    } catch {
      return false;
    }
  }

  /**
   * If dirty, ask Save / Don't Save / Cancel. Returns false when the user
   * cancels or save fails (caller must keep the current preview).
   */
  async ensureClean(): Promise<boolean> {
    if (!this.dirty) return true;
    const fileName = this.state.descriptor?.fileName ?? this.relativePath ?? '';
    const action = await this.api.preview.confirmUnsaved(fileName);
    if (action === 'cancel') return false;
    if (action === 'save') {
      if (!(await this.save())) return false;
    } else {
      this.setDirty(false);
    }
    return true;
  }

  async open(relativePath: string, options?: { force?: boolean }): Promise<PreviewDescriptor | null> {
    if (!options?.force && this.relativePath === relativePath && this.state.descriptor) {
      return this.state.descriptor;
    }
    if (!(await this.ensureClean())) return null;
    const request = ++this.activeRequest;
    await this.closeCurrent(false);
    this.relativePath = relativePath;
    this.update({ descriptor: null, status: 'loading', error: null });
    try {
      const result = await this.api.preview.open(relativePath);
      if (request !== this.activeRequest) {
        if (result.ok) void this.api.preview.close(result.value.sessionId);
        return null;
      }
      if (!result.ok) throw new Error(result.message || tPreview('error.open'));
      this.update({ descriptor: result.value, status: 'ready', error: null });
      return result.value;
    } catch (error) {
      if (request === this.activeRequest) {
        this.update({ descriptor: null, status: 'error', error: toMessage(error) });
      }
      return null;
    }
  }

  /** Close without prompting (caller already confirmed or is disposing). */
  async closeForced(): Promise<void> {
    ++this.activeRequest;
    await this.closeCurrent(true);
    this.relativePath = null;
  }

  async readText(sessionId: string): Promise<PreviewTextResult> {
    const result = await this.api.preview.readText(sessionId);
    if (!result.ok) throw new Error(result.message || tPreview('error.readText'));
    return result.value;
  }

  async writeBytes(sessionId: string, bytes: Uint8Array): Promise<PreviewWriteResult> {
    const bytesBase64 = uint8ToBase64(bytes);
    const result = await this.api.preview.writeBytes(sessionId, bytesBase64);
    if (!result.ok) throw new Error(result.message || tPreview('error.saveSpreadsheet'));
    const current = this.state.descriptor;
    if (current && current.sessionId === sessionId) {
      this.update({
        ...this.state,
        descriptor: {
          ...current,
          size: result.value.size,
          mtimeMs: result.value.mtimeMs,
        },
      });
    }
    return result.value;
  }

  async listArchive(sessionId: string): Promise<ArchiveEntry[]> {
    const result = await this.api.archive.list(sessionId);
    if (!result.ok) throw new Error(result.message || tPreview('error.listArchive'));
    return result.value;
  }

  async openArchiveEntry(sessionId: string, path: string): Promise<ArchiveEntryPreview> {
    const result = await this.api.archive.readEntry(sessionId, path);
    if (!result.ok) throw new Error(result.message || tPreview('error.readArchiveEntry'));
    return result.value;
  }

  async exportArchiveEntry(sessionId: string, path: string): Promise<void> {
    const result = await this.api.archive.exportEntry(sessionId, path);
    if (!result.ok) throw new Error(result.message || tPreview('error.exportArchiveEntry'));
  }

  async extractArchive(sessionId: string): Promise<string> {
    const result = await this.api.archive.extract(sessionId);
    if (!result.ok) throw new Error(result.message || tPreview('error.extractArchive'));
    return result.value;
  }

  async decompileJava(sessionId: string): Promise<string> {
    const result = await this.api.preview.decompileJava(sessionId);
    if (!result.ok) throw new Error(result.message || tPreview('error.decompileJava'));
    return result.value.output;
  }

  async sendHttp(request: HttpPreviewRequest): Promise<HttpPreviewResponse> {
    const result = await this.api.preview.sendHttp(request);
    if (!result.ok) throw new Error(result.message || tPreview('error.http'));
    return result.value;
  }

  dispose(): void {
    this.dirty = false;
    this.saveHandler = null;
    void this.closeCurrent(true);
    this.listeners.clear();
  }

  private async closeCurrent(reset: boolean): Promise<void> {
    const descriptor = this.state.descriptor;
    if (descriptor) await this.api.preview.close(descriptor.sessionId);
    if (this.relativePath) void this.api.preview.setDirty(this.relativePath, false);
    this.dirty = false;
    if (reset) this.update({ descriptor: null, status: 'idle', error: null });
  }

  private update(state: PreviewState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : tPreview('error.load');
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
