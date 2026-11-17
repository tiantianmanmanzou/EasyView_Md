import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OperationResult } from '@easyview/contracts';
import type { DesktopTabSnapshot } from '../../../contracts';
import {
  failure,
  getWindowContext,
  publishMenuCommand,
  runInWindowContext,
  sendToWindow,
  success,
  syncTabState,
  tabRegistry,
  tabSnapshot,
} from '../host/desktopRuntime';
import type { DesktopWindowContext } from '../host/windowContext';
import { tBrowser } from './browser.i18n';
import {
  browserTabFileName,
  isBrowserDocumentUrl,
  parseBrowserAddress,
  type BrowserBounds,
} from './browserPolicy';
import {
  browserDownloadsDirectory,
  BrowserViewService,
  type BrowserLayoutRequest,
  type BrowserViewState,
} from './BrowserViewService';

const services = new WeakMap<DesktopWindowContext, BrowserViewService>();

export interface OpenBrowserRequest {
  url?: string;
  relativePath?: string;
  id?: string;
  groupId?: string;
  /** Load the address in the current browser tab instead of opening another one. */
  reuse?: boolean;
  notify?: boolean;
}

function browserViews(): BrowserViewService {
  const context = getWindowContext();
  const existing = services.get(context);
  if (existing) return existing;
  const inOwner = <T>(operation: () => T): T => runInWindowContext(context, operation);
  const created = new BrowserViewService({
    getWindow: () => context.window,
    zoomFactor: () => {
      const window = context.window;
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return 1;
      return window.webContents.getZoomFactor();
    },
    sendState: (state) => inOwner(() => publishBrowserState(state)),
    onPopup: (openerTabId, decision) => inOwner(() => {
      if (decision.action === 'new-tab') void openBrowserTab({ url: decision.url });
      else if (decision.action === 'reuse') void navigateBrowserTab(openerTabId, decision.url);
      else browserViews().download(openerTabId, decision.url);
    }),
    onShortcut: (command) => inOwner(() => publishMenuCommand(command)),
    downloadsDirectory: browserDownloadsDirectory,
    preferSaveDialog: () => process.env.EASYVIEW_E2E_BACKGROUND !== '1',
  });
  services.set(context, created);
  return created;
}

function publishBrowserState(state: BrowserViewState): void {
  sendToWindow('browser.state', state);
  const updated = tabRegistry.updateBrowser(state.tabId, {
    url: state.url || 'about:blank',
    title: state.title,
    fileName: browserTabFileName(state.url || 'about:blank', state.title, tBrowser('newTab')),
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  });
  if (updated?.labelChanged) syncTabState();
}

export async function resolveBrowserAddress(input: string): Promise<string | null> {
  const parsed = parseBrowserAddress(input);
  if (!parsed) return null;
  if (parsed.kind === 'url') return parsed.url;
  let filePath = parsed.path;
  if (filePath.startsWith('~/')) filePath = path.join(os.homedir(), filePath.slice(2));
  return pathToFileURL(path.resolve(filePath)).href;
}

export async function openBrowserTab(request: OpenBrowserRequest = {}): Promise<OperationResult<DesktopTabSnapshot>> {
  const notify = request.notify !== false;
  const url = request.url ?? 'about:blank';
  if (!isBrowserDocumentUrl(url)) return failure('INVALID_ARGUMENT', tBrowser('invalidAddress'));
  const views = browserViews();
  if (request.reuse) {
    const active = tabRegistry.active();
    if (active?.kind === 'browser') return navigateBrowserTab(active.id, url);
  }
  if (url !== 'about:blank') {
    const groupId = request.groupId;
    const existing = tabRegistry.findBrowser(url, request.relativePath, groupId);
    if (existing) {
      tabRegistry.activate(existing.id);
      views.ensure(existing.id, existing.url);
      return success(notify ? syncTabState() : tabSnapshot());
    }
  }
  const fileName = browserTabFileName(url, undefined, tBrowser('newTab'));
  const tab = tabRegistry.openBrowser({
    id: request.id,
    url,
    fileName,
    title: fileName,
    relativePath: request.relativePath,
    groupId: request.groupId,
  });
  views.ensure(tab.id, url);
  return success(notify ? syncTabState() : tabSnapshot());
}

export async function navigateBrowserTab(tabId: string, address: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const tab = tabRegistry.get(tabId);
  if (tab?.kind !== 'browser') return failure('NOT_FOUND', tBrowser('notFound'));
  const url = await resolveBrowserAddress(address);
  if (!url) return failure('INVALID_ARGUMENT', tBrowser('invalidAddress'));
  browserViews().navigate(tabId, url);
  tabRegistry.updateBrowser(tabId, {
    url,
    loading: true,
    fileName: browserTabFileName(url, undefined, tBrowser('newTab')),
    title: '',
  });
  return success(syncTabState());
}

export function goBrowser(tabId: string, direction: 'back' | 'forward' | 'reload'): OperationResult<boolean> {
  const tab = tabRegistry.get(tabId);
  if (tab?.kind !== 'browser') return failure('NOT_FOUND', tBrowser('notFound'));
  browserViews().go(tabId, direction);
  return success(true);
}

export function applyBrowserLayout(request: BrowserLayoutRequest): void {
  const views = services.get(getWindowContext());
  if (!views) return;
  for (const entry of request.views) {
    const tab = tabRegistry.get(entry.tabId);
    if (tab?.kind === 'browser') views.ensure(tab.id, tab.url);
  }
  views.applyLayout(request);
}

export function releaseBrowserTabs(tabIds: readonly string[]): void {
  services.get(getWindowContext())?.closeTabs(tabIds);
}

export function retargetBrowserFile(oldRelativePath: string, nextRelativePath: string, fileName: string, filePath: string): void {
  const url = pathToFileURL(filePath).href;
  const ids = tabRegistry.renameBrowser(oldRelativePath, nextRelativePath, fileName, url);
  const views = services.get(getWindowContext());
  for (const id of ids) views?.navigate(id, url);
}

export function disposeBrowserViews(): void {
  const context = getWindowContext();
  services.get(context)?.dispose();
  services.delete(context);
}

export function isBrowserLayout(value: unknown): value is BrowserLayoutRequest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { obscured?: unknown; views?: unknown };
  if (typeof record.obscured !== 'boolean' || !Array.isArray(record.views)) return false;
  return record.views.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const view = entry as { tabId?: unknown; bounds?: unknown };
    return typeof view.tabId === 'string' && (view.bounds === null || isBounds(view.bounds));
  });
}

function isBounds(value: unknown): value is BrowserBounds {
  if (typeof value !== 'object' || value === null) return false;
  const bounds = value as Record<string, unknown>;
  return (['x', 'y', 'width', 'height'] as const).every((key) => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]));
}
