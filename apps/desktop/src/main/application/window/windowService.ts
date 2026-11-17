import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  shell,
} from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import { buildRecentFolderShellItems, windowsOpenFolderArguments } from './recentFolderShell';
import { fileURLToPath } from 'node:url';
import { requestRestart } from '../document/appLifecycle';
import { flushDesktopEditors } from '../document/flushDesktopEditors';
import { showAboutDialog } from '../help/aboutDialog';
import { anonymizePath, buildFeedbackMailto, buildIssueUrl, FEEDBACK_REPO_URL, type FeedbackEnvironment } from '../help/feedbackLinks';
import os from 'node:os';
import { getLogsDirectory, log as appLog } from '../help/appLogger';
import { cancelUpdateDownload, checkForUpdates, getUpdateSettings, isDownloadingUpdate, setAutoCheck, setUpdateMenuRefresher, updatesDisabled } from '../update/updateService';
import {
  WINDOW_ZOOM_LEVEL_MAX,
  WINDOW_ZOOM_LEVEL_MIN,
} from '../document/appState';
import {
  confirmCloseAll,
  closeTab,
  importDocument,
  openFromMenu,
  requestOpenDocument,
  saveFromMenu,
  showOperationError,
  stopWatcher,
  watchDocumentSession,
  restoreWorkspace,
} from '../document/documentWorkflow';
import { createAppStateStore } from '../document/appState';
import { openWorkspaceFolder } from '../workspace/workspaceWorkflow';
import { recentFolderStore } from '../workspace/recentFolders';
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
  sendToWindow,
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
import { DESKTOP_ACCENTS, DESKTOP_APPEARANCE_MODES, DESKTOP_DOCUMENT_FONTS, DESKTOP_LOCALE_ARGUMENT_PREFIX as LOCALE_ARGUMENT_PREFIX, DESKTOP_OPENED_FILE_AT_LAUNCH_ARGUMENT, DESKTOP_THEME_DEPTH_STEPS, DESKTOP_TAB_CLOSE_SHORTCUT } from '../../../contracts';
import type { DesktopAccent, DesktopAppearanceMode, DesktopDocumentFont, DesktopMenuCommand, DesktopThemeDepthStep } from '../../../contracts';
import { getLocale, type LocalePreference } from '@easyview/contracts';
import { getSelectedLanguagePreference, saveLanguagePreference } from '../settings/languageSettings';
import { tMenu } from './windowService.i18n';
import { disposeBrowserViews } from '../browser/browserWorkflow';

const appearanceModeLabel = (mode: DesktopAppearanceMode) => tMenu(`appearance.${mode}`);
const themeDepthLabel = (step: DesktopThemeDepthStep) => tMenu(`depth.${step}`);
const accentLabel = (accent: DesktopAccent) => tMenu(`accent.${accent}`);
const documentFontLabel = (font: DesktopDocumentFont) => tMenu(`font.${font}`);
const LANGUAGE_OPTIONS: readonly LocalePreference[] = ['system', 'zh-CN', 'en'];
// Language names stay in their own language so users can always find their way back.
const languageLabel = (preference: LocalePreference) =>
  preference === 'system' ? tMenu('view.languageSystem') : preference === 'zh-CN' ? '简体中文' : 'English'; // i18n-ignore

async function chooseLanguage(preference: LocalePreference): Promise<void> {
  if (preference === getSelectedLanguagePreference()) return;
  await saveLanguagePreference(app.getPath('userData'), preference);
  createMenu();
  const window = getMainWindow();
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: tMenu('language.restartTitle'),
    message: tMenu('language.restartMessage'),
    detail: tMenu('language.restartDetail'),
    buttons: [tMenu('language.restartNow'), tMenu('language.restartLater')],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (response === 0) await restartApp();
}

let openedFileAtLaunch = false;

/** The next window skips the startup welcome page because the launch already opened a document. */
export function markOpenedFileAtLaunch(): void {
  openedFileAtLaunch = true;
}

function consumeOpenedFileAtLaunch(): boolean {
  const value = openedFileAtLaunch;
  openedFileAtLaunch = false;
  return value;
}

const RESTART_FLAG = '--easyview-restart';
const NEW_WINDOW_FLAG = '--easyview-new-window';

export function argvRequestsRestart(argv: string[]): boolean {
  return argv.includes(RESTART_FLAG);
}

export function argvRequestsNewWindow(argv: string[]): boolean {
  return argv.includes(NEW_WINDOW_FLAG);
}

const TITLE_ROW_HEIGHT = 32;
const TRAFFIC_LIGHT_X = 12;
const TRAFFIC_LIGHT_HEIGHT = 16;

export function applyWindowZoomLevel(level: number): void {
  const next = Math.max(WINDOW_ZOOM_LEVEL_MIN, Math.min(WINDOW_ZOOM_LEVEL_MAX, Math.round(level)));
  getAppStateStore().setZoomLevel(next);
  const target = getMainWindow();
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  target.webContents.setZoomLevel(next);
  syncWindowChromeToZoom(target, next);
  sendToWindow('app.zoomChanged', target.webContents.getZoomFactor());
}

/** The renderer's 32px title row scales with page zoom; keep the native window controls centered in it. */
function syncWindowChromeToZoom(target: BrowserWindow, zoomLevel: number): void {
  const height = Math.round(TITLE_ROW_HEIGHT * Math.pow(1.2, zoomLevel));
  if (process.platform === 'darwin') {
    target.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y: Math.max(0, Math.round((height - TRAFFIC_LIGHT_HEIGHT) / 2)) });
  } else {
    target.setTitleBarOverlay({ height });
  }
}

export function zoomWindowBy(delta: number): void {
  applyWindowZoomLevel(getAppStateStore().getZoomLevel() + delta);
}

export function resetWindowZoom(): void {
  applyWindowZoomLevel(0);
}

let restartRequest: Promise<boolean> | undefined;
export async function restartApp(): Promise<void> {
  if (restartRequest) { await restartRequest; return; }
  restartRequest = requestRestart({
    windows: () => windowSessions.values().map(({ context }) => ({
      prepare: () => flushDesktopEditors(context, [...context.documentSessions.values()]),
      hasDirtyDocuments: () => context.documentSessions.hasDirty(),
      confirmCloseAll: () => runInWindowContext(context, confirmCloseAll),
    })),
    relaunch() {
      app.relaunch();
      app.exit(0);
    },
  });
  try { await restartRequest; }
  catch (error) { await dialog.showMessageBox({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { restartRequest = undefined; }
}

export function syncShellMenu(): void {
  const context = getWindowContext();
  if (process.platform === 'darwin' && app.dock) {
    // macOS appends the open-window list (key window checked) above these items.
    const recents = buildRecentFolderShellItems(recentFolderStore().snapshot(), os.homedir());
    app.dock.setMenu(Menu.buildFromTemplate([
      ...recents.map((item): Electron.MenuItemConstructorOptions => ({ label: item.label, toolTip: item.displayPath, click: () => { void openFolderFromShell(item.path); } })),
      ...(recents.length > 0 ? [{ type: 'separator' as const }] : []),
      { label: tMenu('shell.newWindow'), click: () => { void createNewWindow(); } },
      { type: 'separator' },
      { label: tMenu('shell.restart'), click: () => runInWindowContext(context, () => { void restartApp(); }) },
    ]));
    return;
  }

  if (process.platform === 'win32') {
    const recentTasks = buildRecentFolderShellItems(recentFolderStore().snapshot(), os.homedir()).flatMap((item) => {
      const args = windowsOpenFolderArguments(item.path);
      return args ? [{ program: process.execPath, arguments: args, iconPath: process.execPath, iconIndex: 0, title: item.label, description: item.displayPath }] : [];
    });
    app.setUserTasks([
      ...recentTasks,
      {
        program: process.execPath,
        arguments: NEW_WINDOW_FLAG,
        iconPath: process.execPath,
        iconIndex: 0,
        title: tMenu('shell.newWindow'),
        description: tMenu('shell.newWindowDescription'),
      },
      {
        program: process.execPath,
        arguments: RESTART_FLAG,
        iconPath: process.execPath,
        iconIndex: 0,
        title: tMenu('shell.restart'),
        description: tMenu('shell.restartDescription'),
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

function feedbackEnvironment(): FeedbackEnvironment {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release(),
    arch: process.arch,
    electronVersion: process.versions.electron,
    logsDirectory: anonymizePath(getLogsDirectory(), { platform: process.platform, homeDir: os.homedir(), appData: process.env.APPDATA, userProfile: process.env.USERPROFILE }),
  };
}

/** Dock / Jump List entry: focus the window already showing this folder, otherwise open it in a new window. */
export async function openFolderFromShell(folderPath: string): Promise<void> {
  const target = await realpath(folderPath).catch(() => folderPath);
  const same = (candidate: string | null) => Boolean(candidate) && (process.platform === 'darwin' || process.platform === 'win32'
    ? path.resolve(candidate!).toLowerCase() === path.resolve(target).toLowerCase()
    : path.resolve(candidate!) === path.resolve(target));
  for (const session of windowSessions.values()) {
    const window = session.context.window;
    if (!window || window.isDestroyed()) continue;
    if (same(runInWindowContext(session.context, () => getWorkspaceState().rootPath))) {
      if (window.isMinimized()) window.restore();
      if (!backgroundTestRun) {
        window.show();
        window.focus();
      }
      appLog('info', 'shell', 'focused existing window for recent folder');
      return;
    }
  }
  const window = await createNewWindow();
  const session = windowSessions.fromWebContents(window.webContents);
  if (!session) return;
  if (window.webContents.isLoading()) await once(window.webContents, 'did-finish-load');
  appLog('info', 'shell', 'opening recent folder in a new window');
  await runInWindowContext(session.context, async () => {
    const result = await openWorkspaceFolder(target);
    if (!result.ok) await showOperationError(result);
  });
}

async function openRecentFolderFromMenu(folderPath: string): Promise<void> {
  const result = await openWorkspaceFolder(folderPath);
  if (!result.ok) await showOperationError(result);
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
  const md = (label: string, value: DesktopMenuCommand, options: Partial<Electron.MenuItemConstructorOptions> = {}): Electron.MenuItemConstructorOptions =>
    command(label, value, { enabled: menuState.isMarkdownDocument, ...options });
  const appearanceItem = (id: string, label: string, value: DesktopMenuCommand, checked: boolean): Electron.MenuItemConstructorOptions => ({
    id, label, type: 'radio', checked, click: inContext(() => publishMenuCommand(value)),
  });
  const nearestDepth = DESKTOP_THEME_DEPTH_STEPS.reduce((best, step) =>
    Math.abs(step - menuState.themeDepth) < Math.abs(best - menuState.themeDepth) ? step : best);
  const recentFiles = getAppStateStore().getRecentFiles();
  const recentFolders = recentFolderStore().snapshot();
  const isMac = process.platform === 'darwin';
  const closeActiveTab = inContext(() => {
    const tab = tabRegistry.active();
    if (tab) void closeTab(tab.id).then(showOperationError);
  });
  const appItems: Electron.MenuItemConstructorOptions[] = [
    { label: tMenu('file.restart'), click: inContext(() => { void restartApp(); }) },
    { label: tMenu('file.newWindow'), click: () => { void createNewWindow(); } },
  ];
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: tMenu('app.about'), click: () => { void showAboutDialog(); } },
        { type: 'separator' },
        ...appItems,
        { type: 'separator' },
        { role: 'hide', label: tMenu('app.hide') },
        { role: 'hideOthers', label: tMenu('app.hideOthers') },
        { role: 'unhide', label: tMenu('app.showAll') },
        { type: 'separator' },
        { role: 'quit', label: tMenu('file.quit') },
      ] satisfies Electron.MenuItemConstructorOptions[],
    }] : []),
    {
      label: tMenu('file'),
      submenu: [
        { label: tMenu('file.open'), accelerator: 'CmdOrCtrl+O', click: inContext(() => { void openFromMenu(); }) },
        { label: tMenu('file.openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: inContext(() => { void openWorkspaceFolder(); }) },
        {
          label: tMenu('file.recent'),
          submenu: recentFiles.length > 0
            ? recentFiles.map((filePath) => ({ label: path.basename(filePath), sublabel: filePath, click: inContext(() => { void requestOpenDocument(filePath); }) }))
            : [{ label: tMenu('file.noRecentFiles'), enabled: false }],
        },
        {
          label: tMenu('file.recentFolders'),
          submenu: recentFolders.length > 0
            ? recentFolders.map((folderPath) => ({ label: path.basename(folderPath) || folderPath, sublabel: folderPath, click: inContext(() => { void openRecentFolderFromMenu(folderPath); }) }))
            : [{ label: tMenu('file.noRecentFolders'), enabled: false }],
        },
        { type: 'separator' },
        { label: tMenu('file.rename'), enabled: menuState.hasActiveDocument, click: inContext(() => publishMenuCommand('rename')) },
        { label: tMenu('file.importWord'), click: inContext(() => { void importDocument(['docx', 'doc'], tMenu('file.wordFilter')); }) },
        { label: tMenu('file.importPdf'), click: inContext(() => { void importDocument(['pdf'], tMenu('file.pdfFilter')); }) },
        { label: tMenu('file.save'), accelerator: 'CmdOrCtrl+S', enabled: menuState.hasActiveDocument, click: inContext(() => { void saveFromMenu(false); }) },
        { label: tMenu('file.saveAs'), accelerator: 'CmdOrCtrl+Shift+S', enabled: menuState.hasActiveDocument, click: inContext(() => { void saveFromMenu(true); }) },
        { label: tMenu('file.closeTab'), accelerator: DESKTOP_TAB_CLOSE_SHORTCUT.accelerator, enabled: !!tabRegistry.active(), click: closeActiveTab },
        ...(process.platform === 'win32' ? [{ label: tMenu('file.closeTab'), accelerator: DESKTOP_TAB_CLOSE_SHORTCUT.windowsSecondary, visible: false, acceleratorWorksWhenHidden: true, enabled: !!tabRegistry.active(), click: closeActiveTab }] : []),
        ...(isMac ? [] : [
          { type: 'separator' as const },
          ...appItems,
          { role: 'quit' as const, label: tMenu('file.quit') },
        ]),
      ],
    },
    {
      label: tMenu('edit'),
      submenu: [
        { role: 'undo', label: tMenu('edit.undo') },
        { role: 'redo', label: tMenu('edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: tMenu('edit.cut') },
        { role: 'copy', label: tMenu('edit.copy') },
        { role: 'paste', label: tMenu('edit.paste') },
        { role: 'selectAll', label: tMenu('edit.selectAll') },
        { type: 'separator' },
        command(tMenu('edit.findReplace'), 'findReplace', { accelerator: 'CmdOrCtrl+H' }),
      ],
    },
    {
      label: tMenu('view'),
      submenu: [
        {
          label: tMenu('view.themeMode'),
          submenu: [
            ...DESKTOP_APPEARANCE_MODES.map((mode) => appearanceItem(`appearance-mode-${mode}`, appearanceModeLabel(mode), `setThemeMode:${mode}`, menuState.themeMode === mode)),
            { type: 'separator' },
            { label: tMenu('view.cycleTheme'), click: inContext(() => publishMenuCommand('toggleTheme')) },
          ],
        },
        {
          label: tMenu('view.themeDepth'),
          submenu: DESKTOP_THEME_DEPTH_STEPS.map((step) => appearanceItem(`appearance-depth-${step}`, themeDepthLabel(step), `setThemeDepth:${step}`, nearestDepth === step)),
        },
        {
          label: tMenu('view.accent'),
          submenu: DESKTOP_ACCENTS.map((accent) => appearanceItem(`appearance-accent-${accent}`, accentLabel(accent), `setAccent:${accent}`, menuState.accent === accent)),
        },
        {
          label: tMenu('view.documentFont'),
          submenu: DESKTOP_DOCUMENT_FONTS.map((font) => appearanceItem(`appearance-font-${font}`, documentFontLabel(font), `setDocumentFont:${font}`, menuState.documentFont === font)),
        },
        {
          label: tMenu('view.language'),
          submenu: LANGUAGE_OPTIONS.map((preference) => ({
            id: `language-${preference}`,
            label: languageLabel(preference),
            type: 'radio' as const,
            checked: getSelectedLanguagePreference() === preference,
            click: () => { void chooseLanguage(preference); },
          })),
        },
        { type: 'separator' },
        { label: 'IndexArea', type: 'checkbox', checked: getWorkspaceState().explorerVisible, click: inContext(() => publishMenuCommand('toggleExplorer')) },
        { type: 'separator' },
        { label: tMenu('view.zoomIn'), accelerator: 'CmdOrCtrl+=', registerAccelerator: true, click: inContext(() => zoomWindowBy(1)) },
        { label: tMenu('view.zoomIn'), accelerator: 'CmdOrCtrl+Plus', visible: false, acceleratorWorksWhenHidden: true, click: inContext(() => zoomWindowBy(1)) },
        { label: tMenu('view.zoomOut'), accelerator: 'CmdOrCtrl+-', click: inContext(() => zoomWindowBy(-1)) },
        { label: tMenu('view.resetZoom'), accelerator: 'CmdOrCtrl+0', click: inContext(() => resetWindowZoom()) },
        { type: 'separator' },
        command(tMenu('view.openBrowser'), 'openBrowser', { id: 'view-open-browser', accelerator: 'CmdOrCtrl+Shift+B', enabled: true }),
        {
          id: 'view-command-palette',
          label: tMenu('view.commandPalette'),
          accelerator: 'CmdOrCtrl+Shift+P',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: inContext(() => publishMenuCommand('openCommandPalette')),
        },
      ],
    },
    {
      label: tMenu('markdown'),
      submenu: [
        md(tMenu('view.outline'), 'toggleOutline', { type: 'checkbox', checked: menuState.outlineVisible }),
        md(tMenu('view.sourceMode'), 'toggleSourceMode', { type: 'checkbox', checked: menuState.sourceMode }),
        md(tMenu('view.fullWidth'), 'toggleFullWidth', { type: 'checkbox', checked: menuState.fullWidth }),
        md(tMenu('view.tableWrap'), 'toggleTableWrap', { type: 'checkbox', checked: menuState.tableWrap }),
        md(tMenu('view.viewChanges'), 'toggleViewChanges', { type: 'checkbox', checked: menuState.viewChanges, accelerator: 'Alt+V' }),
        { type: 'separator' },
        md(tMenu('document.toggleHeadings'), 'toggleHeadingCollapse'),
        md(tMenu('document.history'), 'toggleHistory'),
        md(tMenu('document.stickyNote'), 'toggleStickyNote'),
        { type: 'separator' },
        md(tMenu('view.scrollTop'), 'scrollTop'),
        md(tMenu('view.scrollBottom'), 'scrollBottom'),
        { type: 'separator' },
        {
          label: tMenu('export'),
          enabled: menuState.isMarkdownDocument,
          submenu: [md(tMenu('export.htmlLight'), 'exportHtmlLight'), md(tMenu('export.htmlDark'), 'exportHtmlDark'), md(tMenu('export.pdfLight'), 'exportPdfLight'), md(tMenu('export.pdfDark'), 'exportPdfDark'), md('DOCX', 'exportDocx')],
        },
      ],
    },
    // Git actions target the repository of the active document, independent of its file type.
    { label: tMenu('repository'), submenu: [command(tMenu('git.stage'), 'stageFile'), command(tMenu('git.commit'), 'openCommit'), command(tMenu('git.sync'), 'syncGit')] },
    { role: 'windowMenu', label: tMenu('window') },
    { label: tMenu('tools'), submenu: [command(tMenu('tools.aiChat'), 'toggleAiChat', { accelerator: 'Alt+I', enabled: true }), command(tMenu('tools.terminal'), 'openTerminal')] },
    {
      label: tMenu('help'),
      role: 'help',
      submenu: [
        { label: tMenu('help.reportIssue'), click: () => { void shell.openExternal(buildIssueUrl(feedbackEnvironment())); } },
        { label: tMenu('help.emailFeedback'), click: () => { void shell.openExternal(buildFeedbackMailto(feedbackEnvironment())); } },
        { label: tMenu('help.openLogs'), click: () => { const dir = getLogsDirectory(); void mkdir(dir, { recursive: true }).then(() => shell.openPath(dir)); } },
        { type: 'separator' },
        ...(updatesDisabled() ? [] : [
          { label: tMenu('help.checkUpdates'), click: () => { void checkForUpdates(true); } },
          { label: tMenu('help.autoCheckUpdates'), type: 'checkbox' as const, checked: getUpdateSettings().autoCheck, click: (item: Electron.MenuItem) => { void setAutoCheck(item.checked); } },
          { label: tMenu('help.cancelUpdateDownload'), visible: isDownloadingUpdate(), click: () => cancelUpdateDownload() },
          { type: 'separator' as const },
        ]),
        { label: tMenu('help.homepage'), click: () => { void shell.openExternal(FEEDBACK_REPO_URL); } },
        { type: 'separator' },
        { label: tMenu('help.about'), click: () => { void showAboutDialog(); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  syncShellMenu();
}

/** Local e2e runs keep every window hidden and unfocused so tests don't disturb the user. */
export const backgroundTestRun = process.env.EASYVIEW_E2E_BACKGROUND === '1';

export function createWindow(context: DesktopWindowContext = getWindowContext()): BrowserWindow {
  return runInWindowContext(context, () => {
  setActiveWindowContext(context);
  const bounds = getAppStateStore().getWindowBounds();
  appLog('info', 'window', 'creating window');
  const window = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 960,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    // Native window controls share the renderer's top tab row.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: (TITLE_ROW_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2 } }
      : { titleBarOverlay: { height: TITLE_ROW_HEIGHT, color: nativeTheme.shouldUseDarkColors ? '#272727' : '#f3f3f3', symbolColor: nativeTheme.shouldUseDarkColors ? '#cccccc' : '#333333' } }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      additionalArguments: [
        `${LOCALE_ARGUMENT_PREFIX}${getLocale()}`,
        ...(consumeOpenedFileAtLaunch() ? [DESKTOP_OPENED_FILE_AT_LAUNCH_ARGUMENT] : []),
      ],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      backgroundThrottling: !backgroundTestRun,
    },
  });
  setMainWindow(window);

  const webContentsId = window.webContents.id;
  windowSessions.register(window.webContents, context);
  // Page zoom is keyed by URL, so it can only be applied once this window's own URL has loaded.
  window.webContents.on('did-finish-load', () => runInWindowContext(context, () => applyWindowZoomLevel(getAppStateStore().getZoomLevel())));
  updateWindowTitle();
  for (const session of documentSessions.values()) void watchDocumentSession(session);
  // The renderer's <title> would otherwise replace the file/folder title the Dock and Window menu list.
  window.on('page-title-updated', (event) => event.preventDefault());
  window.once('ready-to-show', () => {
    if (!window.isDestroyed() && !backgroundTestRun) window.show();
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
    // The preview toolbar's print button renders a printable snapshot into a blank same-origin
    // window and prints it; allow exactly that (no URL, no node access), deny everything else.
    if (url === 'about:blank' || url === '') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900,
          height: 700,
          autoHideMenuBar: true,
          show: !backgroundTestRun,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: !backgroundTestRun },
        },
      };
    }
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isCurrentRendererUrl(url)) event.preventDefault();
  });
  // Text fields without a page-provided menu (tree rename, search boxes) get the standard edit menu.
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const { editFlags } = params;
    Menu.buildFromTemplate([
      { role: 'undo', label: tMenu('edit.undo'), enabled: editFlags.canUndo },
      { role: 'redo', label: tMenu('edit.redo'), enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: tMenu('edit.cut'), enabled: editFlags.canCut },
      { role: 'copy', label: tMenu('edit.copy'), enabled: editFlags.canCopy },
      { role: 'paste', label: tMenu('edit.paste'), enabled: editFlags.canPaste },
      { role: 'selectAll', label: tMenu('edit.selectAll'), enabled: editFlags.canSelectAll },
    ]).popup({ window });
  });
  window.on('close', (event) => runInWindowContext(context, () => {
    if (isWindowClosing() || (!documentSessions.hasDirty() && !tabRegistry.hasDirtyPreviews())) return;
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
    disposeBrowserViews();
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
  // Chromium shares page zoom between pages with the same URL; a per-window query keeps each window's zoom independent.
  void window.loadFile(rendererHtmlPath(), { query: { window: String(webContentsId) } });
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
    onSaveError: (error) => console.warn(`[EasyView_Md] failed to save state for window ${id}:`, error),
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
setUpdateMenuRefresher(() => createMenu());
