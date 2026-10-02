import { app, BrowserWindow, crashReporter } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const ENABLE_DIAGNOSTICS = process.env.EASYVIEW_DIAG === '1';

function resolveDiagLogPath(): string {
  return process.env.EASYVIEW_DIAG_LOG || path.join(process.cwd(), 'easyview-diagnostics.log');
}

function logDiagnostic(category: string, message: string, data?: unknown): void {
  if (!ENABLE_DIAGNOSTICS) return;

  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${category}] ${message}`;
  const fullEntry =
    data !== undefined
      ? `${logEntry}\n  Data: ${JSON.stringify(data, null, 2)}\n`
      : `${logEntry}\n`;

  // Prefer stderr so Start-Process -RedirectStandardError captures it on Windows.
  console.error(fullEntry.trim());

  try {
    fs.appendFileSync(resolveDiagLogPath(), fullEntry);
  } catch (error) {
    console.error('[EasyView_Md diag] Failed to write diagnostic log:', error);
  }
}

/**
 * CI-only diagnostics. Production behavior is unchanged unless EASYVIEW_DIAG=1.
 */
export function setupDiagnostics(): void {
  if (!ENABLE_DIAGNOSTICS) return;

  const diagLogPath = resolveDiagLogPath();
  logDiagnostic('INIT', 'Diagnostics enabled', {
    logPath: diagLogPath,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    argv: process.argv,
    envFlags: {
      EASYVIEW_DIAG: process.env.EASYVIEW_DIAG,
      ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING,
    },
  });

  try {
    const crashDumpsDir = app.getPath('crashDumps');
    fs.mkdirSync(crashDumpsDir, { recursive: true });

    crashReporter.start({
      productName: 'EasyView_Md',
      companyName: 'EasyView',
      // Local dumps only; upload disabled.
      submitURL: 'https://localhost.invalid/crash-report',
      uploadToServer: false,
      compress: false,
      ignoreSystemCrashHandler: false,
      extra: {
        diagnosticMode: 'true',
      },
    });

    logDiagnostic('CRASH_REPORTER', 'Crash reporter initialized', {
      crashDumpsDir,
    });
  } catch (error) {
    logDiagnostic('CRASH_REPORTER', 'Failed to initialize crash reporter', {
      error: String(error),
    });
  }

  process.on('uncaughtException', (error) => {
    logDiagnostic('PROCESS', 'Uncaught exception', {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
  });

  process.on('unhandledRejection', (reason) => {
    logDiagnostic('PROCESS', 'Unhandled rejection', {
      reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason),
    });
  });

  process.on('exit', (code) => {
    // Best-effort final breadcrumb (may not flush on hard kill).
    try {
      fs.appendFileSync(
        resolveDiagLogPath(),
        `[${new Date().toISOString()}] [PROCESS] exit code=${code}\n`,
      );
    } catch {
      // ignore
    }
  });

  app.on('before-quit', (event) => {
    logDiagnostic('APP', 'before-quit', {
      defaultPrevented: event.defaultPrevented,
    });
  });

  app.on('will-quit', (event) => {
    logDiagnostic('APP', 'will-quit', {
      defaultPrevented: event.defaultPrevented,
    });
  });

  app.on('quit', (_event, exitCode) => {
    logDiagnostic('APP', 'quit', { exitCode });
  });

  app.on('window-all-closed', () => {
    logDiagnostic('APP', 'window-all-closed', {
      platform: process.platform,
      windowCount: BrowserWindow.getAllWindows().length,
    });
  });

  app.on('gpu-info-update', () => {
    try {
      logDiagnostic('APP', 'gpu-info-update', {
        gpuFeatureStatus: app.getGPUFeatureStatus(),
      });
    } catch (error) {
      logDiagnostic('APP', 'gpu-info-update (failed to read status)', {
        error: String(error),
      });
    }
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    logDiagnostic('APP', 'render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      webContentsId: webContents.id,
    });
  });

  app.on('child-process-gone', (_event, details) => {
    logDiagnostic('APP', 'child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    });
  });

  logDiagnostic('INIT', 'All diagnostic handlers registered');
}

export function setupWindowDiagnostics(window: BrowserWindow): void {
  if (!ENABLE_DIAGNOSTICS) return;

  const windowId = window.id;

  logDiagnostic('WINDOW', `created id=${windowId}`, {
    bounds: window.getBounds(),
    isVisible: window.isVisible(),
    showFlag: false,
  });

  window.on('ready-to-show', () => {
    logDiagnostic('WINDOW', `ready-to-show id=${windowId}`);
  });

  window.on('show', () => {
    logDiagnostic('WINDOW', `show id=${windowId}`);
  });

  window.on('close', (event) => {
    logDiagnostic('WINDOW', `close id=${windowId}`, {
      defaultPrevented: event.defaultPrevented,
    });
  });

  window.on('closed', () => {
    logDiagnostic('WINDOW', `closed id=${windowId}`);
  });

  window.on('unresponsive', () => {
    logDiagnostic('WINDOW', `unresponsive id=${windowId}`);
  });

  window.on('responsive', () => {
    logDiagnostic('WINDOW', `responsive id=${windowId}`);
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logDiagnostic('WEBCONTENTS', `did-fail-load id=${windowId}`, {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    logDiagnostic('WEBCONTENTS', `render-process-gone id=${windowId}`, {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  window.webContents.on('did-finish-load', () => {
    logDiagnostic('WEBCONTENTS', `did-finish-load id=${windowId}`);
  });

  window.webContents.on('dom-ready', () => {
    logDiagnostic('WEBCONTENTS', `dom-ready id=${windowId}`);
  });
}
