import { app, BrowserWindow, nativeTheme, protocol } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { createAppStateStore } from '../../application/document/appState';
import { createDesktopAiChatHost } from '../../application/ai/createDesktopAiChatHost';
import { readDocument, requestOpenDocument, restoreWorkspace } from '../../application/document/documentWorkflow';
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
  argvRequestsRestart,
  createMenu,
  createWindow,
  findMarkdownArgument,
  restartApp,
} from '../../application/window/windowService';
import { registerDesktopIpc } from './registerDesktopIpc';
import { registerPreviewProtocol, registerPreviewScheme } from './previewProtocol';

if (!squirrelStartup) registerPreviewScheme();

const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argvRequestsRestart(argv)) {
      void restartApp();
      return;
    }
    const filePath = findMarkdownArgument(argv);
    if (filePath) {
      void requestOpenDocument(filePath).catch((error) => {
        console.error('[EasyView_Md] 打开第二实例文档失败:', error);
      });
    }
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!isMarkdownPath(filePath)) return;
    if (!getMainWindow()) {
      setPendingOpenPath(filePath);
      return;
    }
    void requestOpenDocument(filePath).catch((error) => {
      console.error('[EasyView_Md] 打开文件失败:', error);
    });
  });

  app.whenReady().then(async () => {
    if (!getPendingOpenPath()) setPendingOpenPath(findMarkdownArgument(process.argv));
    const appStateStore = createAppStateStore(app.getPath('userData'), {
      onSaveError: (error) => {
        console.warn('[EasyView_Md] 应用状态保存失败:', error);
      },
    });
    setAppStateStore(appStateStore);
    await appStateStore.load();
    setAiChatHost(createDesktopAiChatHost());
    registerPreviewProtocol(protocol, previewProtocolSessions);
    registerDesktopIpc();
    await restoreWorkspace();
    createMenu();
    if (getPendingOpenPath()) {
      const filePath = getPendingOpenPath()!;
      setPendingOpenPath(undefined);
      const result = await readDocument(filePath);
      if (!result.ok) console.error('[EasyView_Md] 启动文件打开失败:', result.message);
    }
    createWindow();
    nativeTheme.on('updated', () => {
      sendToWindow(
        'app.themeChanged',
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      );
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
