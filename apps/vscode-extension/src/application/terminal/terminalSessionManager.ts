import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TerminalService, type TerminalSessionInfo } from '@easyview/node-runtime';
import type * as NodePty from 'node-pty';
import { logOpenWithDebug } from '../document/openWithDebug';

interface PanelTerminalSession {
  info: TerminalSessionInfo;
}

const sessions = new WeakMap<vscode.WebviewPanel, PanelTerminalSession>();
const panelsBySessionId = new Map<string, vscode.WebviewPanel>();
let terminalService: TerminalService | undefined;

function loadPackagedNodePty(): typeof NodePty {
  return require(path.join(__dirname, 'runtime', 'node-pty', 'lib', 'index.js')) as typeof NodePty;
}

function post(panel: vscode.WebviewPanel, message: Record<string, unknown>): void {
  void panel.webview.postMessage(message);
}

function getTerminalService(): TerminalService {
  if (terminalService) return terminalService;
  const nodePtyPackageRoot = path.join(__dirname, 'runtime', 'node-pty');
  terminalService = new TerminalService({
    defaultCwd: os.homedir(),
    nodePty: loadPackagedNodePty(),
    nodePtyPackageRoot,
    onData(sessionId, data) {
      const panel = panelsBySessionId.get(sessionId);
      if (!panel) return;
      post(panel, { type: 'terminalData', sessionId, data });
    },
    onExit(sessionId, exitCode, signal) {
      const panel = panelsBySessionId.get(sessionId);
      if (!panel) return;
      panelsBySessionId.delete(sessionId);
      const active = sessions.get(panel);
      if (active?.info.sessionId === sessionId) sessions.delete(panel);
      post(panel, {
        type: 'terminalExit',
        sessionId,
        code: exitCode,
        signal: signal ?? null,
      });
    },
  });
  return terminalService;
}

function postOpened(panel: vscode.WebviewPanel, info: TerminalSessionInfo): void {
  post(panel, {
    type: 'terminalOpened',
    sessionId: info.sessionId,
    cwd: info.cwd,
    platform: process.platform,
    homeDir: os.homedir(),
  });
}

export function openTerminalForPanel(panel: vscode.WebviewPanel, cwd: string): void {
  const existing = sessions.get(panel);
  if (existing) {
    if (existing.info.cwd === cwd) {
      postOpened(panel, existing.info);
      return;
    }
    disposeTerminalForPanel(panel);
  }

  try {
    const info = getTerminalService().open({ cwd });
    sessions.set(panel, { info });
    panelsBySessionId.set(info.sessionId, panel);
    logOpenWithDebug('host.terminalSession.created', {
      sessionId: info.sessionId,
      cwd: info.cwd,
      shell: info.shell,
      initialCols: info.cols,
      initialRows: info.rows,
    });
    postOpened(panel, info);
  } catch (error) {
    post(panel, {
      type: 'terminalError',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeTerminalInput(panel: vscode.WebviewPanel, data: string): void {
  const session = sessions.get(panel);
  if (!session) return;
  getTerminalService().write(session.info.sessionId, data);
}

export function resizeTerminalForPanel(panel: vscode.WebviewPanel, cols: number, rows: number): void {
  const session = sessions.get(panel);
  if (!session) return;
  try {
    getTerminalService().resize(session.info.sessionId, cols, rows);
    session.info.cols = Math.floor(cols);
    session.info.rows = Math.floor(rows);
    logOpenWithDebug('host.terminalSession.resized', {
      sessionId: session.info.sessionId,
      cwd: session.info.cwd,
      cols: session.info.cols,
      rows: session.info.rows,
    });
  } catch {
    // The renderer validates dimensions; only a concurrent terminal close can fail here.
  }
}

export function disposeTerminalForPanel(panel: vscode.WebviewPanel): void {
  const session = sessions.get(panel);
  if (!session) return;
  sessions.delete(panel);
  panelsBySessionId.delete(session.info.sessionId);
  logOpenWithDebug('host.terminalSession.disposed', {
    sessionId: session.info.sessionId,
    cwd: session.info.cwd,
  });
  getTerminalService().close(session.info.sessionId);
}
