import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  isEasyViewThemeMode,
  type EasyViewThemeMode,
  type PreviewDescriptor,
  type PreviewTextResult,
  type PreviewWriteResult,
} from '@easyview/contracts';
import {
  PreviewShell,
  type PreviewAssetConfig,
  type PreviewHost,
  type PreviewState,
  type PreviewThemeMode,
  type PreviewThemeStorage,
} from '@easyview/preview-ui';

declare global {
  interface Window {
    __EASYVIEW_PREVIEW_BOOTSTRAP__?: {
      type: 'init';
      descriptor: PreviewDescriptor;
      assets: PreviewAssetConfig;
      productTheme?: EasyViewThemeMode;
      fileTheme?: EasyViewThemeMode | null;
    };
    acquireVsCodeApi?: () => {
      postMessage(message: unknown): void;
      getState?(): unknown;
      setState?(state: unknown): void;
    };
  }
}

const vscode = window.acquireVsCodeApi?.();

const PREVIEW_UI_STATE_VERSION = 1;
type PreviewUiState = {
  version: typeof PREVIEW_UI_STATE_VERSION;
  scrollTop: number;
  scrollLeft: number;
};

function readPreviewUiState(): PreviewUiState | null {
  const state = vscode?.getState?.();
  if (!state || typeof state !== 'object') return null;
  const candidate = state as Partial<PreviewUiState>;
  if (candidate.version !== PREVIEW_UI_STATE_VERSION) return null;
  const { scrollTop, scrollLeft } = candidate;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop)) return null;
  if (typeof scrollLeft !== 'number' || !Number.isFinite(scrollLeft)) return null;
  return {
    version: PREVIEW_UI_STATE_VERSION,
    scrollTop: Math.max(0, scrollTop),
    scrollLeft: Math.max(0, scrollLeft),
  };
}

function getPreviewScrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.preview-content');
}

function savePreviewUiState(): void {
  if (!vscode?.setState) return;
  const container = getPreviewScrollContainer();
  if (!container) return;
  // Keep only viewport facts. Never put descriptor content or viewer bytes in VS Code state.
  vscode.setState({
    version: PREVIEW_UI_STATE_VERSION,
    scrollTop: container.scrollTop,
    scrollLeft: container.scrollLeft,
  } satisfies PreviewUiState);
}

function restorePreviewUiState(state: PreviewUiState | null): void {
  if (!state) return;
  const restore = () => {
    const container = getPreviewScrollContainer();
    if (!container) return;
    container.scrollTop = state.scrollTop;
    container.scrollLeft = state.scrollLeft;
  };
  requestAnimationFrame(() => {
    restore();
    requestAnimationFrame(restore);
  });
}

function installPreviewUiStatePersistence(): void {
  let scheduled = false;
  const scheduleSave = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      savePreviewUiState();
    });
  };
  document.addEventListener('scroll', scheduleSave, true);
  window.addEventListener('pagehide', savePreviewUiState);
}

class ExtensionPreviewHost implements PreviewHost {
  private readonly listeners = new Set<() => void>();
  private state: PreviewState;

  constructor(descriptor: PreviewDescriptor) {
    this.state = { descriptor, status: 'ready', error: null };
  }

  getState = (): PreviewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async readText(sessionId: string): Promise<PreviewTextResult> {
    if (!vscode) throw new Error('VS Code API 不可用');
    const id = crypto.randomUUID();
    return new Promise<PreviewTextResult>((resolve, reject) => {
      const handle = (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.type !== 'readTextResult' || data.id !== id) return;
        window.removeEventListener('message', handle);
        if (data.ok) resolve(data.value as PreviewTextResult);
        else reject(new Error(data.message || '文本读取失败'));
      };
      window.addEventListener('message', handle);
      vscode.postMessage({ type: 'readText', id, sessionId });
    });
  }

  async writeBytes(sessionId: string, bytes: Uint8Array): Promise<PreviewWriteResult> {
    if (!vscode) throw new Error('VS Code API 不可用');
    const id = crypto.randomUUID();
    const bytesBase64 = uint8ToBase64(bytes);
    return new Promise<PreviewWriteResult>((resolve, reject) => {
      const handle = (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.type !== 'writeBytesResult' || data.id !== id) return;
        window.removeEventListener('message', handle);
        if (data.ok) {
          const value = data.value as PreviewWriteResult;
          const current = this.state.descriptor;
          if (current && current.sessionId === sessionId) {
            this.state = {
              ...this.state,
              descriptor: {
                ...current,
                size: value.size,
                mtimeMs: value.mtimeMs,
              },
            };
            this.listeners.forEach((listener) => listener());
          }
          resolve(value);
        } else {
          reject(new Error(data.message || '表格保存失败'));
        }
      };
      window.addEventListener('message', handle);
      vscode.postMessage({
        type: 'writeBytes',
        id,
        sessionId,
        encoding: 'base64',
        bytes: bytesBase64,
      });
    });
  }
}

function createExtensionPreviewThemeStorage(
  productTheme: PreviewThemeMode,
  fileTheme: PreviewThemeMode | null,
  relativePath: string,
): PreviewThemeStorage {
  let currentProduct = productTheme;
  const fileThemes = new Map<string, PreviewThemeMode>();
  if (fileTheme) fileThemes.set(relativePath, fileTheme);

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'productThemeChanged' || !isEasyViewThemeMode(data.mode)) return;
    currentProduct = data.mode;
    document.documentElement.dataset.easyviewTheme = data.mode;
    document.body.dataset.easyviewTheme = data.mode;
    window.dispatchEvent(new CustomEvent('easyview:productThemeChanged', {
      detail: { mode: data.mode, isDark: data.mode === 'dark' },
    }));
  });

  return {
    getProductTheme: () => currentProduct,
    readFileTheme: (path) => fileThemes.get(path) ?? null,
    writeFileTheme: (path, mode) => {
      fileThemes.set(path, mode);
      vscode?.postMessage({ type: 'writePreviewFileTheme', relativePath: path, mode });
    },
  };
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bootstrap(): void {
  const savedUiState = readPreviewUiState();
  installPreviewUiStatePersistence();
  const payload = window.__EASYVIEW_PREVIEW_BOOTSTRAP__;
  const rootEl = document.getElementById('root');
  if (!payload || !rootEl) return;
  const productTheme = isEasyViewThemeMode(payload.productTheme) ? payload.productTheme : 'light';
  const fileTheme = isEasyViewThemeMode(payload.fileTheme) ? payload.fileTheme : null;
  const themeStorage = createExtensionPreviewThemeStorage(
    productTheme,
    fileTheme,
    payload.descriptor.relativePath,
  );
  const host = new ExtensionPreviewHost(payload.descriptor);
  createRoot(rootEl).render(
    React.createElement(PreviewShell, {
      host,
      assets: {
        ...payload.assets,
        themeStorage,
      },
    }),
  );
  restorePreviewUiState(savedUiState);
}

bootstrap();
