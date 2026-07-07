import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { logOpenWithDebug } from './openWithDebug';

type NodePtyModule = typeof import('node-pty');

type TerminalSession = {
  id: string;
  cwd: string;
  pty: import('node-pty').IPty;
  closed: boolean;
  cols: number;
  rows: number;
};

const sessions = new WeakMap<vscode.WebviewPanel, TerminalSession>();

function createSessionId(): string {
  return `easyview-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadNodePty(): NodePtyModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node-pty') as NodePtyModule;
}

function ensureNodePtyHelperPermissions(): void {
  if (process.platform !== 'darwin') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgJsonPath = require.resolve('node-pty/package.json');
    const pkgDir = path.dirname(pkgJsonPath);
    const helperPath = path.join(pkgDir, 'prebuilds', process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64', 'spawn-helper');
    if (fs.existsSync(helperPath)) {
      fs.chmodSync(helperPath, 0o755);
    }
  } catch {
    // Ignore permission adjustments when the helper path cannot be resolved.
  }
}

function resolveShell(): { file: string; args: string[]; env: Record<string, string> } {
  const baseEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    ),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'EasyView',
    // Suppress zsh's PROMPT_SP feature which prints a stray "%" in the top-left
    // corner of a freshly opened terminal. Setting PROMPT_SP to empty disables
    // the partial-line indicator without touching user's .zshrc.
    PROMPT_SP: '',
  };

  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC || 'powershell.exe';
    return {
      file: shell,
      args: shell.toLowerCase().includes('powershell') ? ['-NoLogo'] : [],
      env: baseEnv,
    };
  }

  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  return {
    file: shell,
    args: [],
    env: {
      ...baseEnv,
      SHELL: shell,
    },
  };
}

function post(panel: vscode.WebviewPanel, message: Record<string, unknown>): void {
  void panel.webview.postMessage(message);
}

function createTerminalSession(panel: vscode.WebviewPanel, cwd: string): TerminalSession {
  ensureNodePtyHelperPermissions();
  const nodePty = loadNodePty();
  const shell = resolveShell();
  const initialCols = 120;
  const initialRows = 32;
  const pty = nodePty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cwd,
    env: shell.env,
    cols: initialCols,
    rows: initialRows,
  });

  const session: TerminalSession = {
    id: createSessionId(),
    cwd,
    pty,
    closed: false,
    cols: initialCols,
    rows: initialRows,
  };

  logOpenWithDebug('host.terminalSession.created', {
    sessionId: session.id,
    cwd,
    shell: shell.file,
    initialCols,
    initialRows,
  });

  pty.onData((data) => {
    if (session.closed) return;
    post(panel, {
      type: 'terminalData',
      sessionId: session.id,
      data,
    });
  });

  pty.onExit(({ exitCode, signal }) => {
    session.closed = true;
    sessions.delete(panel);
    post(panel, {
      type: 'terminalExit',
      sessionId: session.id,
      code: exitCode,
      signal: signal ?? null,
    });
  });

  sessions.set(panel, session);
  post(panel, {
    type: 'terminalOpened',
    sessionId: session.id,
    cwd,
    platform: process.platform,
    homeDir: os.homedir(),
  });
  return session;
}

export function openTerminalForPanel(panel: vscode.WebviewPanel, cwd: string): void {
  const existing = sessions.get(panel);
  if (existing && !existing.closed) {
    if (existing.cwd === cwd) {
      post(panel, {
        type: 'terminalOpened',
        sessionId: existing.id,
        cwd: existing.cwd,
        platform: process.platform,
        homeDir: os.homedir(),
      });
      return;
    }
    disposeTerminalForPanel(panel);
  }

  try {
    createTerminalSession(panel, cwd);
  } catch (error) {
    post(panel, {
      type: 'terminalError',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function writeTerminalInput(panel: vscode.WebviewPanel, data: string): void {
  const session = sessions.get(panel);
  if (!session || session.closed || !data) return;
  session.pty.write(data);
}

export function resizeTerminalForPanel(panel: vscode.WebviewPanel, cols: number, rows: number): void {
  const session = sessions.get(panel);
  if (!session || session.closed) return;
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
  const nextCols = Math.max(1, Math.floor(cols));
  const nextRows = Math.max(1, Math.floor(rows));
  if (session.cols === nextCols && session.rows === nextRows) return;
  try {
    session.pty.resize(nextCols, nextRows);
    session.cols = nextCols;
    session.rows = nextRows;
    logOpenWithDebug('host.terminalSession.resized', {
      sessionId: session.id,
      cwd: session.cwd,
      cols: nextCols,
      rows: nextRows,
    });
  } catch {
    // Ignore transient resize failures when terminal is closing.
  }
}

export function disposeTerminalForPanel(panel: vscode.WebviewPanel): void {
  const session = sessions.get(panel);
  if (!session) return;
  session.closed = true;
  sessions.delete(panel);
  logOpenWithDebug('host.terminalSession.disposed', {
    sessionId: session.id,
    cwd: session.cwd,
  });
  try {
    session.pty.kill();
  } catch {
    // Ignore shutdown errors.
  }
}
