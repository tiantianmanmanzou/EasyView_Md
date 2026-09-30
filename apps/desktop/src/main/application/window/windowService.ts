import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  shell,
} from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { requestRestart } from '../document/appLifecycle';
import {
  WINDOW_ZOOM_LEVEL_MAX,
  WINDOW_ZOOM_LEVEL_MIN,
} from '../document/appState';
import {
  confirmCloseAll,
  importDocument,
  openFromMenu,
  requestOpenDocument,
  saveFromMenu,
  stopWatcher,
  watchDocumentSession,
  restoreWorkspace,
} from '../document/documentWorkflow';
import { createAppStateStore } from '../document/appState';
import { openWorkspaceFolder } from '../workspace/workspaceWorkflow';
import {
  documentSessions,
  getAppStateStore,
  getDesktopMenuState,
  getMainWindow,
  getTerminalService,
  getWorkspaceState,
  hostHooks,
  isAllowedExternalUrl,
  isWindowClosing,
  isMarkdownPath,
  previewSessions,
  publishMenuCommand,
  setActiveTerminalSessionId,
  setActiveWindowContext,
  setClosing,
  setMainWindow,
  setTerminalService,
  tabRegistry,
  updateWindowTitle,
  windowSessions,
  getWindowContext,
  runInWindowContext,
} from '../host/desktopRuntime';
import type { DesktopWindowContext } from '../host/windowContext';
import { createDesktopWindowContext } from '../host/windowContext';
import type { DesktopMenuCommand } from '../../../contracts';

const RESTART_FLAG = '--easyview-restart';

export function argvRequestsRestart(argv: string[]): boolean {
  return argv.includes(RESTART_FLAG);
}

export function applyWindowZoomLevel(level: number): void {
  const next = Math.max(WINDOW_ZOOM_LEVEL_MIN, Math.min(WINDOW_ZOOM_LEVEL_MAX, Math.round(level)));
  getAppStateStore().setZoomLevel(next);
  const target = getMainWindow();
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  target.webContents.setZoomLevel(next);
}

export function zoomWindowBy(delta: number): void {
  applyWindowZoomLevel(getAppStateStore().getZoomLevel() + delta);
}

export function resetWindowZoom(): void {
  applyWindowZoomLevel(0);
}

export async function restartApp(): Promise<void> {
  if (isWindowClosing()) return;
  await requestRestart({
    hasDirtyDocuments: documentSessions.hasDirty(),
    confirmCloseAll,
    relaunch() {
      setClosing(true);
      app.relaunch();
      app.exit(0);
    },
  });
}

export function syncShellRestartMenu(): void {
  const context = getWindowContext();
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: '重启', click: () => runInWindowContext(context, () => { void restartApp(); }) },
    ]));
    return;
  }

  if (process.platform === 'win32') {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: RESTART_FLAG,
        iconPath: process.execPath,
        iconIndex: 0,
        title: '重启',
        description: '重启 EasyView_Md',
      },
    ]);
  }
}

function rendererHtmlPath(): string {
  return path.join(__dirname, '../renderer/index.html');
}

function isCurrentRendererUrl(value: string): boolean {
  try {
    return path.resolve(fileURLToPath(new URL(value))) === path.resolve(rendererHtmlPath());
  } catch {
    return false;
  }
}

export function createMenu(): void {
  const context = getWindowContext();
  const inContext = (operation: () => void): (() => void) => () => runInWindowContext(context, operation);
  const menuState = getDesktopMenuState();
  const command = (label: string, value: DesktopMenuCommand, options: Partial<Electron.MenuItemConstructorOptions> = {}): Electron.MenuItemConstructorOptions => ({
    label,
    enabled: menuState.hasActiveDocument,
    click: inContext(() => publishMenuCommand(value)),
    ...options,
  });
  const recentFiles = getAppStateStore().getRecentFiles();
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: inContext(() => { void openFromMenu(); }) },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: inContext(() => { void openWorkspaceFolder(); }) },
        {
          label: '最近打开',
          submenu: recentFiles.length > 0
            ? recentFiles.map((filePath) => ({ label: path.basename(filePath), sublabel: filePath, click: inContext(() => { void requestOpenDocument(filePath); }) }))
            : [{ label: '暂无最近文件', enabled: false }],
        },
        { type: 'separator' },
        { label: '重命名…', enabled: menuState.hasActiveDocument, click: inContext(() => publishMenuCommand('rename')) },
        { label: '导入 Word…', click: inContext(() => { void importDocument(['docx', 'doc'], 'Word Document'); }) },
        { label: '导入 PDF…', click: inContext(() => { void importDocument(['pdf'], 'PDF Document'); }) },
        { label: '保存', accelerator: 'CmdOrCtrl+S', enabled: menuState.hasActiveDocument, click: inContext(() => { void saveFromMenu(false); }) },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', enabled: menuState.hasActiveDocument, click: inContext(() => { void saveFromMenu(true); }) },
        { type: 'separator' },
        { label: '重启', click: inContext(() => { void restartApp(); }) },
        { label: '新建窗口', click: inContext(() => { void createNewWindow(); }) },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        command('查找和替换…', 'findReplace', { accelerator: 'CmdOrCtrl+H' }),
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '目录树', type: 'checkbox', checked: getWorkspaceState().explorerVisible, click: inContext(() => publishMenuCommand('toggleExplorer')) },
        command('文档目录', 'toggleOutline', { type: 'checkbox', checked: menuState.outlineVisible }),
        command('源码模式', 'toggleSourceMode', { type: 'checkbox', checked: menuState.sourceMode }),
        command('全宽', 'toggleFullWidth', { type: 'checkbox', checked: menuState.fullWidth }),
        command('表格换行', 'toggleTableWrap', { type: 'checkbox', checked: menuState.tableWrap }),
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', registerAccelerator: true, click: inContext(() => zoomWindowBy(1)) },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: inContext(() => zoomWindowBy(1)) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: inContext(() => zoomWindowBy(-1)) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: inContext(() => resetWindowZoom()) },
        { type: 'separator' },
        command('回到顶部', 'scrollTop'),
        command('回到底部', 'scrollBottom'),
      ],
    },
    { label: '文档', submenu: [command('全部展开/折叠标题', 'toggleHeadingCollapse'), command('历史记录', 'toggleHistory'), command('便签', 'toggleStickyNote')] },
    { label: '导出', submenu: [command('HTML（明亮）', 'exportHtmlLight'), command('HTML（暗色）', 'exportHtmlDark'), command('PDF（明亮）', 'exportPdfLight'), command('PDF（暗色）', 'exportPdfDark'), command('DOCX', 'exportDocx')] },
    { label: 'Git', submenu: [command('暂存', 'stageFile'), command('提交', 'openCommit'), command('同步', 'syncGit')] },
    { label: '工具', submenu: [command('AI 对话', 'toggleAiChat', { accelerator: 'Alt+I', enabled: true }), command('内置终端', 'openTerminal')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  syncShellRestartMenu();
}

export function createWindow(context: DesktopWindowContext = getWindowContext()): BrowserWindow {
  return runInWindowContext(context, () => {
  setActiveWindowContext(context);
  const bounds = getAppStateStore().getWindowBounds();
  const window = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 960,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  setMainWindow(window);

  const webContentsId = window.webContents.id;
  windowSessions.register(window.webContents, context);
  applyWindowZoomLevel(getAppStateStore().getZoomLevel());
  updateWindowTitle();
  for (const session of documentSessions.values()) void watchDocumentSession(session);
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.on('focus', () => {
    setActiveWindowContext(context);
    runInWindowContext(context, () => createMenu());
  });
  const rememberWindowBounds = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
    getAppStateStore().setWindowBounds(window.getBounds());
  };
  window.on('resize', () => runInWindowContext(context, rememberWindowBounds));
  window.on('move', () => runInWindowContext(context, rememberWindowBounds));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isCurrentRendererUrl(url)) event.preventDefault();
  });
  window.on('close', (event) => runInWindowContext(context, () => {
    if (isWindowClosing() || !documentSessions.hasDirty()) return;
    event.preventDefault();
    void confirmCloseAll().then((canClose) => {
      if (canClose) {
        setClosing(true);
        if (!window.isDestroyed()) window.close();
      }
    });
  }));
  window.on('closed', () => runInWindowContext(context, () => {
    windowSessions.unregister({ id: webContentsId });
    const fallback = windowSessions.values()[0];
    if (fallback) setActiveWindowContext(fallback.context);
    void Promise.all([...documentSessions.values()].map((session) => stopWatcher(session)));
    getTerminalService()?.disposeAll();
    setTerminalService(undefined);
    previewSessions.closeAll();
    setActiveTerminalSessionId(undefined);
    setMainWindow(undefined);
    setClosing(false);
    context.workspaceWatcher?.stop();
    context.workspaceWatcher = undefined;
    context.documentSessions.clear();
    context.previewSessions.closeAll();
    void context.appStateStore?.save();
    context.appStateStore?.dispose();
    context.workspaceCore.clear();
  }));
  void window.loadFile(rendererHtmlPath());
  return window;
  });
}

export async function createNewWindow(): Promise<BrowserWindow> {
  const id = randomUUID();
  const context = createDesktopWindowContext(id, async (absolutePath) => {
    await shell.trashItem(absolutePath);
  });
  const stateDirectory = path.join(app.getPath('userData'), 'windows', id);
  await mkdir(stateDirectory, { recursive: true });
  context.appStateStore = createAppStateStore(stateDirectory, {
    onSaveError: (error) => console.warn(`[EasyView_Md] 窗口 ${id} 状态保存失败:`, error),
  });
  await context.appStateStore.load();
  return runInWindowContext(context, async () => {
    await restoreWorkspace();
    createMenu();
    return createWindow(context);
  });
}

export function findMarkdownArgument(argv: string[]): string | undefined {
  return argv.find((argument) => path.isAbsolute(argument) && isMarkdownPath(argument));
}

hostHooks.createMenu = createMenu;
