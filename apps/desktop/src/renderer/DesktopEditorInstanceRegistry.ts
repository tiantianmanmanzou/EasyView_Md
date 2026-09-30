import type {
  EditorHostSubscription,
  EditorHostTransport,
  EditorToHostMessage,
  HostToEditorMessage,
} from '@easyview/contracts';
import type { EasyViewEditorInstance, EasyViewThemeMode } from '@easyview/editor-core';
import type { DesktopEditorTab } from '../contracts';

export const DESKTOP_EDITOR_RETAIN_LIMIT = 5;

export interface DesktopEditorFactoryOptions {
  root: HTMLElement;
  host: EditorHostTransport;
  initialMessage?: HostToEditorMessage;
}

export interface DesktopEditorInstanceRegistryOptions {
  mount: HTMLElement;
  capabilities: EditorHostTransport['capabilities'];
  postMessage(message: EditorToHostMessage): void | Promise<void>;
  subscribe(listener: (message: HostToEditorMessage) => void): EditorHostSubscription;
  createEditor(options: DesktopEditorFactoryOptions): EasyViewEditorInstance;
  retainLimit?: number;
}

interface EditorSession {
  tabId: string;
  documentId: string;
  filePath: string;
  root: HTMLElement;
  editor: EasyViewEditorInstance;
  listeners: Set<(message: HostToEditorMessage) => void>;
}

function messageDocumentId(message: HostToEditorMessage): string | null {
  return 'documentId' in message && typeof message.documentId === 'string'
    ? message.documentId
    : null;
}

function createSessionRoot(tabId: string): HTMLElement {
  const root = document.createElement('section');
  root.className = 'desktop-editor-session inlinemd-booting';
  root.dataset.tabId = tabId;
  root.hidden = true;
  root.innerHTML = `
    <div id="editor-body">
      <div id="editor-scroll-area">
        <div id="editor"></div>
      </div>
    </div>
  `;
  return root;
}

function tabDocumentId(tab: DesktopEditorTab): string {
  return tab.documentId ?? tab.documentKey;
}

/**
 * One editor-core instance per Markdown tab. Inactive instances stay dormant
 * with their own undo stacks. The oldest unused instance is disposed once the
 * retain window is exceeded so memory cannot grow without bound.
 */
export class DesktopEditorInstanceRegistry {
  private readonly sessions = new Map<string, EditorSession>();
  private readonly retainLimit: number;
  private readonly lru: string[] = [];
  private readonly pendingSnapshots = new Map<string, HostToEditorMessage>();
  private readonly hostSubscription: EditorHostSubscription;
  private readonly visibleTabIds = new Set<string>();
  private activeTabId: string | null = null;
  private lastFocusedTabId: string | null = null;

  constructor(private readonly options: DesktopEditorInstanceRegistryOptions) {
    this.retainLimit = Math.max(1, options.retainLimit ?? DESKTOP_EDITOR_RETAIN_LIMIT);
    this.hostSubscription = options.subscribe((message) => this.dispatch(message));
  }

  active(): EasyViewEditorInstance | null {
    return this.activeTabId ? this.sessions.get(this.activeTabId)?.editor ?? null : null;
  }

  lastFocused(): EasyViewEditorInstance | null {
    return this.lastFocusedTabId ? this.sessions.get(this.lastFocusedTabId)?.editor ?? null : null;
  }

  first(): EasyViewEditorInstance | null {
    return this.sessions.values().next().value?.editor ?? null;
  }

  has(tabId: string): boolean {
    return this.sessions.has(tabId);
  }

  size(): number {
    return this.sessions.size;
  }

  /** Push the product theme onto every live Markdown instance. Preview file themes are untouched. */
  applyProductTheme(mode: EasyViewThemeMode): void {
    for (const session of this.sessions.values()) session.editor.setThemeMode(mode);
  }

  activate(tab: DesktopEditorTab): EasyViewEditorInstance {
    if (this.activeTabId && this.activeTabId !== tab.id) {
      this.hide(this.activeTabId);
    }
    const editor = this.reveal(tab, this.options.mount);
    this.focus(tab.id);
    this.evictIfNeeded();
    return editor;
  }

  reveal(tab: DesktopEditorTab, mount: HTMLElement = this.options.mount): EasyViewEditorInstance {
    const session = this.sessions.get(tab.id) ?? this.createSession(tab, mount);
    session.documentId = tabDocumentId(tab);
    session.filePath = tab.filePath;
    if (session.root.parentElement !== mount) mount.append(session.root);
    session.root.hidden = false;
    this.visibleTabIds.add(tab.id);
    this.touch(tab.id);
    return session.editor;
  }

  focus(tabId: string): void {
    if (this.activeTabId && this.activeTabId !== tabId) {
      this.sessions.get(this.activeTabId)?.editor.setDocumentActive(false);
    }
    this.activeTabId = tabId;
    this.lastFocusedTabId = tabId;
    this.sessions.get(tabId)?.editor.setDocumentActive(true);
    this.touch(tabId);
  }

  hide(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session) {
      session.editor.setDocumentActive(false);
      session.root.hidden = true;
    }
    this.visibleTabIds.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = null;
    if (this.lastFocusedTabId === tabId) this.lastFocusedTabId = null;
  }

  setVisible(tabs: readonly DesktopEditorTab[], mounts: ReadonlyMap<string, HTMLElement>): void {
    const next = new Set(tabs.map((tab) => tab.id));
    for (const tab of tabs) {
      const mount = mounts.get(tab.id) ?? this.options.mount;
      this.reveal(tab, mount);
    }
    for (const tabId of [...this.visibleTabIds]) {
      if (!next.has(tabId)) this.hide(tabId);
    }
    this.evictIfNeeded();
  }

  clearActive(): void {
    if (this.activeTabId) {
      this.sessions.get(this.activeTabId)?.editor.setDocumentActive(false);
    }
    this.activeTabId = null;
  }

  syncOpenTabs(tabIds: readonly string[]): void {
    const open = new Set(tabIds);
    for (const tabId of [...this.sessions.keys()]) {
      if (!open.has(tabId)) this.disposeSession(tabId);
    }
  }

  dispose(): void {
    this.hostSubscription.unsubscribe();
    for (const tabId of [...this.sessions.keys()]) this.disposeSession(tabId);
    this.activeTabId = null;
    this.pendingSnapshots.clear();
  }

  private createSession(tab: DesktopEditorTab, mount: HTMLElement = this.options.mount): EditorSession {
    const listeners = new Set<(message: HostToEditorMessage) => void>();
    const root = createSessionRoot(tab.id);
    mount.append(root);
    const host: EditorHostTransport = {
      capabilities: this.options.capabilities,
      postMessage: (message) => this.options.postMessage(message),
      subscribe: (listener) => {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    };
    const documentId = tabDocumentId(tab);
    const initialMessage = this.pendingSnapshots.get(documentId);
    if (initialMessage) this.pendingSnapshots.delete(documentId);
    const editor = this.options.createEditor({ root, host, initialMessage });
    const session: EditorSession = {
      tabId: tab.id,
      documentId,
      filePath: tab.filePath,
      root,
      editor,
      listeners,
    };
    this.sessions.set(tab.id, session);
    return session;
  }

  private dispatch(message: HostToEditorMessage): void {
    const documentId = messageDocumentId(message);
    if (message.type === 'documentSnapshot' && documentId) {
      this.pendingSnapshots.set(documentId, message);
      while (this.pendingSnapshots.size > 64) {
        const oldest = this.pendingSnapshots.keys().next().value as string | undefined;
        if (!oldest) break;
        this.pendingSnapshots.delete(oldest);
      }
    }
    if (documentId) {
      const matches = this.sessionsByDocumentId(documentId);
      if (matches.length > 0) {
        for (const session of matches) session.listeners.forEach((listener) => listener(message));
        return;
      }
    }
    if (!this.activeTabId) return;
    this.sessions.get(this.activeTabId)?.listeners.forEach((listener) => listener(message));
  }

  private sessionsByDocumentId(documentId: string): EditorSession[] {
    return [...this.sessions.values()].filter((session) => session.documentId === documentId);
  }

  private touch(tabId: string): void {
    const index = this.lru.indexOf(tabId);
    if (index >= 0) this.lru.splice(index, 1);
    this.lru.push(tabId);
  }

  private evictIfNeeded(): void {
    while (this.lru.length > this.retainLimit) {
      const victim = this.lru.find((tabId) => tabId !== this.activeTabId && !this.visibleTabIds.has(tabId));
      if (!victim) break;
      this.disposeSession(victim);
    }
  }

  private disposeSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.pendingSnapshots.delete(session.documentId);
    this.sessions.delete(tabId);
    this.visibleTabIds.delete(tabId);
    const lruIndex = this.lru.indexOf(tabId);
    if (lruIndex >= 0) this.lru.splice(lruIndex, 1);
    if (this.activeTabId === tabId) this.activeTabId = null;
    session.editor.dispose();
    session.root.remove();
  }
}
