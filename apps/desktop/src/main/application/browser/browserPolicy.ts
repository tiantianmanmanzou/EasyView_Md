import type { WebPreferences } from 'electron';

/** Pure rules for the built-in browser. Electron wiring lives in BrowserViewService. */

export const BROWSER_PARTITION = 'persist:easyview-browser';

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Sandboxed guest: its own session, no Node, no preload, no DevTools. */
export function browserWebPreferences(): WebPreferences {
  return {
    partition: BROWSER_PARTITION,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: false,
  };
}

export function isBrowserDocumentUrl(value: string): boolean {
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:';
  } catch {
    return false;
  }
}

export function isPersistedBrowserUrl(value: string): boolean {
  return isBrowserDocumentUrl(value);
}

export function isLocalHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

export type ParsedBrowserAddress =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string };

/** Address-bar text: http(s), file URLs, bare hosts, or a local filesystem path. */
export function parseBrowserAddress(input: string): ParsedBrowserAddress | null {
  const value = input.trim();
  if (!value) return null;
  if (/^(https?:|file:|about:)/i.test(value)) {
    if (!isBrowserDocumentUrl(value)) return null;
    try {
      return { kind: 'url', url: value === 'about:blank' ? value : new URL(value).href };
    } catch {
      return null;
    }
  }
  if (value.startsWith('/') || value.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    return { kind: 'path', path: value };
  }
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value) && !/\s/.test(value)) {
    return { kind: 'url', url: `https://${value}` };
  }
  return null;
}

export type BrowserPopupDecision =
  | { action: 'deny' }
  | { action: 'download'; url: string }
  | { action: 'new-tab'; url: string }
  | { action: 'reuse'; url: string };

/**
 * New windows requested by the guest. A real new window/tab opens another browser tab;
 * other dispositions stay in the current tab. The native window is always denied.
 */
export function decideBrowserPopup(input: { url: string; disposition: string }): BrowserPopupDecision {
  let url: string;
  try {
    url = input.url === 'about:blank' ? input.url : new URL(input.url).href;
  } catch {
    return { action: 'deny' };
  }
  if (!isBrowserDocumentUrl(url)) return { action: 'deny' };
  if (input.disposition === 'save-to-disk') return { action: 'download', url };
  if (input.disposition === 'new-window' || input.disposition === 'foreground-tab' || input.disposition === 'background-tab') {
    return { action: 'new-tab', url };
  }
  return { action: 'reuse', url };
}

export function scaleBrowserBounds(bounds: BrowserBounds, zoomFactor: number): BrowserBounds {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const scale = (value: number): number => Math.round(value * zoom);
  return {
    x: scale(bounds.x),
    y: scale(bounds.y),
    width: Math.max(0, scale(bounds.width)),
    height: Math.max(0, scale(bounds.height)),
  };
}

export function shouldShowBrowserView(input: { obscured: boolean; bounds: BrowserBounds | null }): boolean {
  if (input.obscured || !input.bounds) return false;
  return input.bounds.width >= 2 && input.bounds.height >= 2;
}

export function browserTabFileName(url: string, title: string | undefined, blankLabel: string): string {
  const trimmed = title?.trim() ?? '';
  if (trimmed && trimmed !== url && trimmed.toLowerCase() !== 'about:blank') return trimmed;
  if (!url || url === 'about:blank') return blankLabel;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '');
      return name || blankLabel;
    }
    const suffix = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${suffix}` || blankLabel;
  } catch {
    return url || blankLabel;
  }
}

export function uniqueDownloadName(filename: string, taken: (name: string) => boolean): string {
  const clean = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'download';
  if (!taken(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const extension = dot > 0 ? clean.slice(dot) : '';
  for (let index = 1; index < 1000; index += 1) {
    const next = `${base} (${index})${extension}`;
    if (!taken(next)) return next;
  }
  return `${base}-${Date.now()}${extension}`;
}

export type DownloadRoute =
  | { kind: 'dialog'; defaultPath: string }
  | { kind: 'file'; savePath: string };

/** Interactive sessions ask with a save dialog; unattended runs write into Downloads. */
export function downloadRoute(input: {
  preferDialog: boolean;
  directory: string;
  filename: string;
  taken: (name: string) => boolean;
  join: (directory: string, name: string) => string;
}): DownloadRoute {
  const name = uniqueDownloadName(input.filename, input.taken);
  const fullPath = input.join(input.directory, input.preferDialog ? (input.filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'download') : name);
  return input.preferDialog ? { kind: 'dialog', defaultPath: fullPath } : { kind: 'file', savePath: input.join(input.directory, name) };
}

export function browserShortcutCommand(input: {
  key: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}): 'openBrowser' | 'openCommandPalette' | null {
  if (!(input.meta || input.control) || !input.shift || input.alt) return null;
  const key = input.key.toLowerCase();
  if (key === 'b') return 'openBrowser';
  if (key === 'p') return 'openCommandPalette';
  return null;
}
