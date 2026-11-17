import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, nativeTheme, session, WebContentsView, type DownloadItem } from 'electron';
import {
  BROWSER_PARTITION,
  browserShortcutCommand,
  browserWebPreferences,
  decideBrowserPopup,
  downloadRoute,
  isBrowserDocumentUrl,
  scaleBrowserBounds,
  shouldShowBrowserView,
  type BrowserBounds,
  type BrowserPopupDecision,
} from './browserPolicy';

export interface BrowserViewState {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserLayoutRequest {
  obscured: boolean;
  views: Array<{ tabId: string; bounds: BrowserBounds | null }>;
}

export interface BrowserViewHooks {
  getWindow(): Electron.BrowserWindow | undefined;
  zoomFactor(): number;
  sendState(state: BrowserViewState): void;
  onPopup(openerTabId: string, decision: Exclude<BrowserPopupDecision, { action: 'deny' }>): void;
  onShortcut(command: 'openBrowser' | 'openCommandPalette'): void;
  downloadsDirectory(): string;
  preferSaveDialog(): boolean;
}

const contentsOwners = new Map<number, BrowserViewService>();
let downloadsInstalled = false;

function installBrowserDownloads(): void {
  if (downloadsInstalled) return;
  downloadsInstalled = true;
  session.fromPartition(BROWSER_PARTITION).on('will-download', (_event, item, webContents) => {
    const owner = contentsOwners.get(webContents.id);
    if (!owner) {
      item.cancel();
      return;
    }
    owner.receiveDownload(item);
  });
}

/**
 * Guest pages for one window. Handlers are attached only to these webContents;
 * the main window's setWindowOpenHandler and will-navigate stay untouched.
 */
export class BrowserViewService {
  private readonly views = new Map<string, WebContentsView>();
  /** Address the user asked for, so a late event from the previous page cannot snap the bar back. */
  private readonly desiredUrl = new Map<string, string>();

  constructor(private readonly hooks: BrowserViewHooks) {
    installBrowserDownloads();
  }

  ensure(tabId: string, url: string): void {
    const existing = this.views.get(tabId);
    if (!existing) {
      this.views.set(tabId, this.createView(tabId, url));
      return;
    }
    const current = existing.webContents.isDestroyed() ? '' : existing.webContents.getURL();
    if ((!current || current === 'about:blank') && url && url !== 'about:blank') {
      void existing.webContents.loadURL(url).catch(() => this.emit(tabId));
    }
  }

  navigate(tabId: string, url: string): void {
    this.desiredUrl.set(tabId, url);
    this.ensure(tabId, url);
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;
    if (view.webContents.getURL() === url) {
      this.desiredUrl.delete(tabId);
      this.emit(tabId);
      return;
    }
    void view.webContents.loadURL(url).catch(() => this.emit(tabId));
  }

  go(tabId: string, direction: 'back' | 'forward' | 'reload'): void {
    const contents = this.views.get(tabId)?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const history = contents.navigationHistory;
    if (direction === 'back') {
      if (history.canGoBack()) history.goBack();
      return;
    }
    if (direction === 'forward') {
      if (history.canGoForward()) history.goForward();
      return;
    }
    contents.reload();
  }

  download(tabId: string, url: string): void {
    const contents = this.views.get(tabId)?.webContents;
    if (!contents || contents.isDestroyed() || !isBrowserDocumentUrl(url)) return;
    contents.downloadURL(url);
  }

  applyLayout(request: BrowserLayoutRequest): void {
    const zoom = this.hooks.zoomFactor();
    const shown = new Set<string>();
    for (const entry of request.views) {
      const view = this.views.get(entry.tabId);
      if (!view || view.webContents.isDestroyed()) continue;
      if (!shouldShowBrowserView({ obscured: request.obscured, bounds: entry.bounds })) {
        view.setVisible(false);
        continue;
      }
      this.attach(view);
      view.setBounds(scaleBrowserBounds(entry.bounds!, zoom));
      view.setVisible(true);
      shown.add(entry.tabId);
    }
    for (const [tabId, view] of this.views) {
      if (!shown.has(tabId) && !view.webContents.isDestroyed()) view.setVisible(false);
    }
  }

  closeTabs(tabIds: readonly string[]): void {
    for (const tabId of tabIds) {
      const view = this.views.get(tabId);
      if (!view) continue;
      this.views.delete(tabId);
      this.desiredUrl.delete(tabId);
      this.destroyView(view);
    }
  }

  receiveDownload(item: DownloadItem): void {
    const directory = this.hooks.downloadsDirectory();
    const route = downloadRoute({
      preferDialog: this.hooks.preferSaveDialog(),
      directory,
      filename: item.getFilename() || 'download',
      taken: (name) => existsSync(path.join(directory, name)),
      join: path.join,
    });
    if (route.kind === 'file') {
      item.setSavePath(route.savePath);
      return;
    }
    item.setSaveDialogOptions({ defaultPath: route.defaultPath });
  }

  dispose(): void {
    for (const view of this.views.values()) this.destroyView(view);
    this.views.clear();
  }

  private createView(tabId: string, url: string): WebContentsView {
    const view = new WebContentsView({ webPreferences: browserWebPreferences() });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff');
    view.setVisible(false);
    contentsOwners.set(view.webContents.id, this);
    this.bindGuest(view, tabId);
    const target = isBrowserDocumentUrl(url) ? url : 'about:blank';
    void view.webContents.loadURL(target).catch(() => this.emit(tabId));
    this.attach(view);
    return view;
  }

  private bindGuest(view: WebContentsView, tabId: string): void {
    const contents = view.webContents;
    contents.setWindowOpenHandler((details) => {
      const decision = decideBrowserPopup({ url: details.url, disposition: details.disposition });
      if (decision.action === 'download') this.download(tabId, decision.url);
      else if (decision.action !== 'deny') this.hooks.onPopup(tabId, decision);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, nextUrl) => {
      if (!isBrowserDocumentUrl(nextUrl)) event.preventDefault();
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      const command = browserShortcutCommand(input);
      if (!command) return;
      event.preventDefault();
      this.hooks.onShortcut(command);
    });
    const emit = (): void => this.emit(tabId);
    contents.on('did-start-loading', emit);
    contents.on('did-stop-loading', emit);
    contents.on('did-finish-load', emit);
    contents.on('did-fail-load', emit);
    contents.on('did-navigate', emit);
    contents.on('did-navigate-in-page', emit);
    contents.on('page-title-updated', emit);
  }

  private attach(view: WebContentsView): void {
    const window = this.hooks.getWindow();
    if (!window || window.isDestroyed()) return;
    window.contentView.addChildView(view);
  }

  private emit(tabId: string): void {
    const contents = this.views.get(tabId)?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const history = contents.navigationHistory;
    const actual = contents.getURL() || 'about:blank';
    const desired = this.desiredUrl.get(tabId);
    const inFlight = !!desired && actual !== desired && contents.isLoading();
    if (!inFlight) this.desiredUrl.delete(tabId);
    const url = inFlight && desired ? desired : actual;
    this.hooks.sendState({
      tabId,
      url,
      title: url === actual ? contents.getTitle() : '',
      loading: inFlight || contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    });
  }

  private destroyView(view: WebContentsView): void {
    if (!view.webContents.isDestroyed()) contentsOwners.delete(view.webContents.id);
    const window = this.hooks.getWindow();
    if (window && !window.isDestroyed()) {
      try { window.contentView.removeChildView(view); } catch { /* already detached */ }
    }
    if (!view.webContents.isDestroyed()) {
      try { view.webContents.close(); } catch { /* The guest page can already be going away with the window. */ }
    }
  }
}

export function browserDownloadsDirectory(): string {
  return app.getPath('downloads');
}
