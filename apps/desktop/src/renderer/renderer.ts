import type { HostToEditorMessage, EditorToHostMessage } from '@easyview/contracts';
import {
  isEasyViewThemeMode,
  readLocalProductTheme,
  type EasyViewThemeMode,
} from '@easyview/contracts';
import { createEasyViewEditor } from '@easyview/editor-core';
import type { DesktopTab, DesktopThemeMode } from '../contracts';
import type { EasyViewDesktopApi } from '../preload/desktopApi';
import type { EasyViewAccentTheme } from '@easyview/editor-core';
import { createDesktopEditorHostTransport } from './desktopHostTransport';
import { WorkspaceExplorer } from './workspace/WorkspaceExplorer';
import { ActiveViewController } from './ActiveViewController';
import { TabController } from './TabController';

interface WindowWithDesktopApi extends Window {
  easyViewDesktop: EasyViewDesktopApi;
  systemLocale?: string;
  csvDelimiterSetting?: string;
  __easyviewPdfFonts?: {
    normal: string;
    bold: string;
    symbols: string;
  };
}

declare const window: WindowWithDesktopApi;

const api = window.easyViewDesktop;
if (!api?.editor || !api.app || !api.document) {
  document.body.innerHTML = '<main style="padding:24px;font-family:system-ui">EasyView_Md 宿主接口加载失败。</main>';
  throw new Error('EasyView_Md preload API is unavailable');
}

const editorHostTransport = createDesktopEditorHostTransport({
  postMessage: (message: EditorToHostMessage) => api.editor.postMessage(message),
  subscribe: (listener: (message: HostToEditorMessage) => void) =>
    api.editor.subscribe(listener),
});

function stampProductTheme(mode: EasyViewThemeMode): void {
  document.documentElement.dataset.easyviewTheme = mode;
  document.body.dataset.easyviewTheme = mode;
  const desktopRoot = document.getElementById('desktop-root');
  if (desktopRoot) desktopRoot.dataset.easyviewTheme = mode;
  document.documentElement.dataset.theme = mode === 'dark' ? 'dark' : 'light';
  document.body.classList.toggle('vscode-dark', mode === 'dark');
  document.body.classList.toggle('vscode-light', mode !== 'dark');
}

function applyOsTheme(theme: DesktopThemeMode): void {
  // Prefer EasyView product theme when present; OS theme only fills gaps.
  const product = readLocalProductTheme(window.localStorage, theme === 'dark' ? 'dark' : 'light');
  stampProductTheme(product);
  window.dispatchEvent(new CustomEvent('inlinemd:themeChanged', {
    detail: { mode: product, isDark: product === 'dark' },
  }));
  window.dispatchEvent(new CustomEvent('easyview:productThemeChanged', {
    detail: { mode: product, isDark: product === 'dark' },
  }));
}

function applyProductThemeFromEditor(): void {
  const mode = editor.getThemeState().mode;
  if (!isEasyViewThemeMode(mode)) return;
  stampProductTheme(mode);
}

window.systemLocale = navigator.language || 'en-US';
window.csvDelimiterSetting = 'auto';
window.__easyviewPdfFonts = {
  normal: new URL('./fonts/SourceHanSansCN-Normal.otf', window.location.href).toString(),
  bold: new URL('./fonts/SourceHanSansCN-Heavy.otf', window.location.href).toString(),
  symbols: new URL('./fonts/NotoSansSymbols2-Regular.ttf', window.location.href).toString(),
};

const editor = createEasyViewEditor({
  host: editorHostTransport,
  uiMode: 'desktop',
  outlinePosition: 'right',
  aiChatContainer: document.getElementById('desktop-ai-chat-host'),
});

const titleName = document.getElementById('desktop-document-name')!;
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;
const themeDepth = document.getElementById('theme-depth') as HTMLInputElement;
const themeControl = document.getElementById('desktop-theme-control')!;
const accentControl = document.getElementById('desktop-accent-control')!;
const accentToggle = document.getElementById('accent-toggle') as HTMLButtonElement;
let themePanelCloseTimer: number | undefined;
const explorerElement = document.getElementById('workspace-explorer')!;
const tabBar = document.getElementById('desktop-tab-bar')!;
const editorBody = document.getElementById('editor-body')!;
const previewBody = document.getElementById('file-preview-root')!;
let currentTab: DesktopTab | null = null;
let tabController: TabController;
const previewApi = api;
const workspaceExplorer = new WorkspaceExplorer({
  api,
  container: explorerElement,
  onStateChange: (state) => {
    editor.setOutlineVisible(state.outlineVisible);
    document.getElementById('workspace-toggle')?.classList.toggle('active', state.explorerVisible);
    publishMenuState();
  },
  onOpenFile: (relativePath) => tabController.openWorkspaceEntry(relativePath),
  onOpenWithDefaultApp: (relativePath) => { void previewApi.system.openWithDefaultApp(relativePath); },
  onRevealInFolder: (relativePath) => { void previewApi.system.revealInFolder(relativePath); },
});

const activeView = new ActiveViewController({
  api, editorBody, previewBody,
  onViewChanged: (view) => {
    const outlineButton = document.getElementById('outline-toggle') as HTMLButtonElement | null;
    if (outlineButton) outlineButton.disabled = view.kind !== 'editor';
    publishMenuState();
  },
});

tabController = new TabController({
  api,
  container: tabBar,
  onActiveTabChanged: (tab) => {
    currentTab = tab;
    editor.setDocumentActive(tab?.kind === 'editor');
    if (!tab) {
      titleName.textContent = 'EasyView_Md';
      titleName.removeAttribute('data-file-path');
      workspaceExplorer.setActiveRelativePath(null);
    } else if (tab.kind === 'editor') {
      titleName.textContent = tab.fileName;
      titleName.dataset.filePath = tab.filePath;
      workspaceExplorer.setActiveDocument(tab.filePath);
    } else {
      titleName.textContent = tab.fileName;
      titleName.removeAttribute('data-file-path');
      workspaceExplorer.setActiveRelativePath(tab.relativePath);
    }
    void activeView.showTab(tab);
    publishMenuState();
  },
});

function publishMenuState(): void {
  const state = editor.getUiState();
  api.menu.publishState({ ...state, hasActiveDocument: currentTab?.kind === 'editor' });
}

document.getElementById('workspace-toggle')?.addEventListener('click', () => workspaceExplorer.toggle());
document.getElementById('outline-toggle')?.addEventListener('click', () => editor.executeCommand('toggleOutline'));
const aiChatToggle = document.getElementById('ai-chat-toggle');
aiChatToggle?.addEventListener('click', () => editor.executeCommand('toggleAiChat'));
window.addEventListener('easyview-ai-chat-visibility-change', (event) => {
  aiChatToggle?.classList.toggle('active', (event as CustomEvent<boolean>).detail);
});
function syncThemeControl(): void {
  const theme = editor.getThemeState();
  const themeDisplay = {
    light: { icon: '☀', label: '亮色主题' },
    gray: { icon: '◐', label: '灰色主题' },
    dark: { icon: '☾', label: '暗色主题' },
  } as const;
  const themeIcons = {
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"></circle><path d="M12 2.5v2.25M12 19.25v2.25M2.5 12h2.25M19.25 12h2.25M5.28 5.28l1.6 1.6M17.12 17.12l1.6 1.6M18.72 5.28l-1.6 1.6M6.88 17.12l-1.6 1.6"></path></svg>',
    gray: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"></path></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.1A8.8 8.8 0 0 1 8.9 3.5 8.8 8.8 0 1 0 20.5 15.1Z"></path></svg>',
  } as const;
  themeToggle.innerHTML = themeIcons[theme.mode];
  themeToggle.title = `${themeDisplay[theme.mode].label}（点击切换）`;
  themeToggle.dataset.mode = theme.mode;
  themeDepth.value = String(Math.round(theme.depth * 100));
}
accentToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5a8.5 8.5 0 1 0 0 17h1.1a1.9 1.9 0 0 0 0-3.8h-.8a1.2 1.2 0 1 1 0-2.4H14a6.5 6.5 0 0 0-2-12.8Z"></path><circle cx="7.7" cy="11" r="1"></circle><circle cx="10.7" cy="7.4" r="1"></circle><circle cx="15.2" cy="8.2" r="1"></circle></svg>';
function syncAccentControl(): void {
  const accent = editor.getAccentTheme();
  accentToggle.dataset.accent = accent;
  accentControl.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach((button) => {
    button.classList.toggle('active', button.dataset.accent === accent);
  });
}
themeToggle.addEventListener('click', () => {
  editor.executeCommand('toggleTheme');
  applyProductThemeFromEditor();
  syncThemeControl();
});
themeDepth.addEventListener('input', () => {
  editor.setThemeDepth(Number(themeDepth.value) / 100);
  syncThemeControl();
});
const openThemePanel = (): void => {
  if (themePanelCloseTimer !== undefined) window.clearTimeout(themePanelCloseTimer);
  themePanelCloseTimer = undefined;
  themeControl.classList.add('is-open');
};
const scheduleThemePanelClose = (): void => {
  if (themePanelCloseTimer !== undefined) window.clearTimeout(themePanelCloseTimer);
  themePanelCloseTimer = window.setTimeout(() => {
    themePanelCloseTimer = undefined;
    themeControl.classList.remove('is-open');
  }, 700);
};
themeControl.addEventListener('pointerenter', openThemePanel);
themeControl.addEventListener('pointerleave', scheduleThemePanelClose);
themeControl.addEventListener('focusin', openThemePanel);
themeControl.addEventListener('focusout', scheduleThemePanelClose);
window.addEventListener('inlinemd:themeChanged', () => {
  applyProductThemeFromEditor();
  syncThemeControl();
});
window.addEventListener('easyview:productThemeChanged', applyProductThemeFromEditor);
accentToggle.addEventListener('click', () => accentControl.classList.toggle('is-open'));
accentControl.querySelectorAll<HTMLButtonElement>('[data-accent]').forEach((button) => {
  button.addEventListener('click', () => {
    editor.setAccentTheme(button.dataset.accent as EasyViewAccentTheme);
    accentControl.classList.remove('is-open');
    syncAccentControl();
  });
});

api.document.onChanged((documentState) => {
  if (currentTab?.kind !== 'editor') return;
  titleName.textContent = documentState.fileName;
  titleName.dataset.filePath = documentState.filePath;
  workspaceExplorer.setActiveDocument(documentState.filePath);
  publishMenuState();
});

const editorStateSubscription = editor.subscribeUiState((state) => {
  document.getElementById('outline-toggle')?.classList.toggle('active', state.outlineVisible);
  workspaceExplorer.setOutlineVisible(state.outlineVisible);
  publishMenuState();
});

window.addEventListener('easyview-toc-width-change', (event) => {
  const width = (event as CustomEvent<number>).detail;
  if (!Number.isFinite(width)) return;
  void api.workspace.getState().then((result) => {
    if (result.ok) void api.workspace.setState({ ...result.value, outlineWidth: width });
  });
});

api.menu.onCommand((command) => {
  if (command === 'toggleExplorer') {
    workspaceExplorer.toggle();
    return;
  }
  if (command === 'rename') {
    const currentName = titleName.textContent ?? '';
    const nextName = window.prompt('重命名 Markdown 文件', currentName);
    if (nextName?.trim()) void api.document.rename(nextName.trim());
    return;
  }
  editor.executeCommand(command);
});

void workspaceExplorer.initialize().then(async (state) => {
  document.getElementById('workspace-toggle')?.classList.toggle('active', state.explorerVisible);
  editor.setOutlineVisible(state.outlineVisible);
  editor.setOutlineWidth(state.outlineWidth);
  await tabController.initialize();
  publishMenuState();
  applyProductThemeFromEditor();
  syncThemeControl();
  syncAccentControl();
});

const themeSubscription = api.app.onThemeChanged(applyOsTheme);
void api.app.getTheme().then((result) => {
  if (result.ok) applyOsTheme(result.value);
  else applyProductThemeFromEditor();
});

window.addEventListener('unload', () => {
  themeSubscription.unsubscribe();
  editorStateSubscription.unsubscribe();
  if (themePanelCloseTimer !== undefined) window.clearTimeout(themePanelCloseTimer);
  tabController.dispose();
  workspaceExplorer.dispose();
  activeView.dispose();
  editor.dispose();
}, { once: true });
