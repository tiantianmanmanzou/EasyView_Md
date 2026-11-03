import { disposeDesktopHistory } from '../../application/document/desktopHistory';
import { app, BrowserWindow, nativeTheme, protocol } from 'electron';
import { resolveLocalePreference, setLocale } from '@easyview/contracts';
import { loadLanguagePreference } from '../../application/settings/languageSettings';
import { createAppStateStore } from '../../application/document/appState';
import { createDesktopAiChatHost } from '../../application/ai/createDesktopAiChatHost';
import { initRecentFolderStore } from '../../application/workspace/recentFolders';
import { initExplorerExpansionStore } from '../../application/workspace/explorerExpansion';
import {
  closeAllTabResources,
  readDocument,
  requestOpenDocument,
  restoreWorkspace,
  showOperationError,
} from '../../application/document/documentWorkflow';
import {
  getMainWindow,
  getPendingOpenPath,
  isMarkdownPath,
  previewProtocolSessions,
  sendToWindow,
  setAiChatHost,
  setAppStateStore,
  setPendingOpenPath,
} from '../../application/host/desktopRuntime';
import {
  argvRequestsNewWindow,
  argvRequestsRestart,
  backgroundTestRun,
  createMenu,
  createNewWindow,
  createWindow,
  openFolderFromShell,
  findMarkdownArgument,
  markOpenedFileAtLaunch,
  restartApp,
} from '../../application/window/windowService';
import { registerDesktopIpc } from './registerDesktopIpc';
import { folderArgumentFromArgv } from '../../application/window/recentFolderShell';
import { registerPreviewProtocol, registerPreviewScheme } from './previewProtocol';
import { ensureOpenWithRegistration } from './fileAssociations';

registerPreviewScheme();

const languagePreference = loadLanguagePreference(app.getPath('userData'));
if (languagePreference !== 'system') app.commandLine.appendSwitch('lang', languagePreference);

let startupComplete = false;
let reopening: Promise<void> | undefined;
let resolveDesktopStarted: () => void = () => {};
/** Resolves once the stores are loaded and the first window exists; menu refreshes before that would fail. */
export const desktopStarted = new Promise<void>((resolve) => { resolveDesktopStarted = resolve; });

function hasOpenWindow(): boolean {
  return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed());
}

function focusMainWindow(): void {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!backgroundTestRun) window.focus();
}

/** Builds the main window from saved state, opening `filePath` on top of the restored tabs. */
async function openMainWindow(filePath?: string): Promise<void> {
  await restoreWorkspace();
  createMenu();
  const result = filePath ? await readDocument(filePath) : undefined;
  if (result?.ok) markOpenedFileAtLaunch();
  createWindow();
  if (result && !result.ok) {
    console.error('[EasyView_Md] Failed to open startup file:', result.message);
    void showOperationError(result);
  }
}

/** macOS keeps the app alive after its last window closes; the next open request rebuilds the window. */
function reopenMainWindow(filePath?: string): Promise<void> {
  reopening ??= (async () => {
    await closeAllTabResources();
    await openMainWindow(filePath);
  })().finally(() => { reopening = undefined; });
  return reopening;
}

/** Finder "Open With", double-click, Dock drop, Explorer "Open with" and command-line paths all land here. */
function openDocumentFromSystem(filePath: string): void {
  if (!startupComplete) {
    setPendingOpenPath(filePath);
    return;
  }
  const opening = hasOpenWindow()
    ? requestOpenDocument(filePath).then(focusMainWindow)
    : (reopening ?? Promise.resolve()).then(() => (
      hasOpenWindow() ? requestOpenDocument(filePath) : reopenMainWindow(filePath)
    ));
  void opening.catch((error) => {
    console.error('[EasyView_Md] Failed to open document:', error);
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argvRequestsRestart(argv)) {
      void restartApp();
      return;
    }
    if (argvRequestsNewWindow(argv)) {
      void createNewWindow();
      return;
    }
    const folderPath = folderArgumentFromArgv(argv);
    if (folderPath && startupComplete) {
      void openFolderFromShell(folderPath);
      return;
    }
    const filePath = findMarkdownArgument(argv);
    if (filePath) {
      openDocumentFromSystem(filePath);
      return;
    }
    if (startupComplete && !hasOpenWindow()) {
      void reopenMainWindow();
      return;
    }
    focusMainWindow();
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!isMarkdownPath(filePath)) return;
    openDocumentFromSystem(filePath);
  });

  app.whenReady().then(async () => {
    // No Dock icon and no app activation, so a test run never takes focus from the user.
    if (backgroundTestRun && process.platform === 'darwin') app.setActivationPolicy('accessory');
    setLocale(resolveLocalePreference(languagePreference, [...app.getPreferredSystemLanguages(), app.getLocale()]));
    if (!getPendingOpenPath()) setPendingOpenPath(findMarkdownArgument(process.argv));
    const appStateStore = createAppStateStore(app.getPath('userData'), {
      onSaveError: (error) => {
        console.warn('[EasyView_Md] Failed to save app state:', error);
      },
    });
    setAppStateStore(appStateStore);
    await appStateStore.load();
    await initRecentFolderStore(app.getPath('userData')).load();
    await initExplorerExpansionStore(app.getPath('userData')).load();
    setAiChatHost(createDesktopAiChatHost());
    registerPreviewProtocol(protocol, previewProtocolSessions);
    registerDesktopIpc();
    const startupFile = getPendingOpenPath();
    setPendingOpenPath(undefined);
    await openMainWindow(startupFile);
    startupComplete = true;
    const launchFolder = folderArgumentFromArgv(process.argv);
    if (launchFolder) void openFolderFromShell(launchFolder);
    resolveDesktopStarted();
    const lateFile = getPendingOpenPath();
    setPendingOpenPath(undefined);
    if (lateFile) openDocumentFromSystem(lateFile);
    void ensureOpenWithRegistration();
    nativeTheme.on('updated', () => {
      sendToWindow(
        'app.themeChanged',
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      );
    });
    app.on('activate', () => {
      if (!hasOpenWindow() && !reopening) void reopenMainWindow();
    });
  });

  app.on('will-quit', disposeDesktopHistory);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
