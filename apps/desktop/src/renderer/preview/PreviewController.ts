import type { ArchiveEntry, ArchiveEntryPreview, HttpPreviewRequest, HttpPreviewResponse, PreviewDescriptor, PreviewTextResult, PreviewWriteResult } from '@easyview/contracts';
import type { PreviewHost, PreviewState, PreviewStatus } from '@easyview/preview-ui';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';

export type { PreviewState, PreviewStatus };

export class PreviewController implements PreviewHost {
  private state: PreviewState = { descriptor: null, status: 'idle', error: null };
  private activeRequest = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: EasyViewDesktopApi) {}

  getState = (): PreviewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(relativePath: string): Promise<PreviewDescriptor | null> {
    const request = ++this.activeRequest;
    await this.closeCurrent(false);
    this.update({ descriptor: null, status: 'loading', error: null });
    try {
      const result = await this.api.preview.open(relativePath);
      if (request !== this.activeRequest) {
        if (result.ok) void this.api.preview.close(result.value.sessionId);
        return null;
      }
      if (!result.ok) throw new Error(result.message || '无法打开预览文件');
      this.update({ descriptor: result.value, status: 'ready', error: null });
      return result.value;
    } catch (error) {
      if (request === this.activeRequest) {
        this.update({ descriptor: null, status: 'error', error: toMessage(error) });
      }
      return null;
    }
  }

  async close(): Promise<void> {
    ++this.activeRequest;
    await this.closeCurrent(true);
  }

  async readText(sessionId: string): Promise<PreviewTextResult> {
    const result = await this.api.preview.readText(sessionId);
    if (!result.ok) throw new Error(result.message || '文本读取失败');
    return result.value;
  }

  async writeBytes(sessionId: string, bytes: Uint8Array): Promise<PreviewWriteResult> {
    const bytesBase64 = uint8ToBase64(bytes);
    const result = await this.api.preview.writeBytes(sessionId, bytesBase64);
    if (!result.ok) throw new Error(result.message || '表格保存失败');
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
    if (!result.ok) throw new Error(result.message || '压缩包目录读取失败');
    return result.value;
  }

  async openArchiveEntry(sessionId: string, path: string): Promise<ArchiveEntryPreview> {
    const result = await this.api.archive.readEntry(sessionId, path);
    if (!result.ok) throw new Error(result.message || '压缩包条目读取失败');
    return result.value;
  }

  async exportArchiveEntry(sessionId: string, path: string): Promise<void> {
    const result = await this.api.archive.exportEntry(sessionId, path);
    if (!result.ok) throw new Error(result.message || '压缩包条目导出失败');
  }

  async decompileJava(sessionId: string): Promise<string> {
    const result = await this.api.preview.decompileJava(sessionId);
    if (!result.ok) throw new Error(result.message || 'Java 反编译失败');
    return result.value.output;
  }

  async sendHttp(request: HttpPreviewRequest): Promise<HttpPreviewResponse> {
    const result = await this.api.preview.sendHttp(request);
    if (!result.ok) throw new Error(result.message || 'HTTP 请求失败');
    return result.value;
  }

  dispose(): void {
    void this.close();
    this.listeners.clear();
  }

  private async closeCurrent(reset: boolean): Promise<void> {
    const descriptor = this.state.descriptor;
    if (descriptor) await this.api.preview.close(descriptor.sessionId);
    if (reset) this.update({ descriptor: null, status: 'idle', error: null });
  }

  private update(state: PreviewState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '预览加载失败';
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
