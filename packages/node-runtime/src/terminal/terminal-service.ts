import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPty, IPtyForkOptions } from 'node-pty';

type NodePtyModule = typeof import('node-pty');
type NodePtyLoader = () => NodePtyModule;

const nodeRequire = typeof require === 'function'
  ? require
  : createRequire(path.join(process.cwd(), 'package.json'));
type TerminalDataListener = (sessionId: string, data: string) => void;
type TerminalExitListener = (sessionId: string, exitCode: number, signal?: number) => void;

export interface OpenTerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalSessionInfo {
  sessionId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

export interface TerminalServiceOptions {
  defaultCwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  nodePty?: NodePtyModule;
  nodePtyPackageRoot?: string;
  chmod?: (filePath: string, mode: number) => void;
  onData?: TerminalDataListener;
  onExit?: TerminalExitListener;
}

interface TerminalSession {
  info: TerminalSessionInfo;
  pty: IPty;
  closed: boolean;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_COLS = 10_000;
const MAX_ROWS = 10_000;

function defaultNodePtyLoader(): NodePtyModule {
  return nodeRequire('node-pty') as NodePtyModule;
}

function createSessionId(): string {
  return `easyview-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDimension(value: number | undefined, fallback: number, name: string): number {
  const normalized = value === undefined ? fallback : Math.floor(value);
  if (!Number.isFinite(normalized) || normalized < 1 || normalized > (name === 'cols' ? MAX_COLS : MAX_ROWS)) {
    throw new RangeError(`${name} must be an integer between 1 and ${name === 'cols' ? MAX_COLS : MAX_ROWS}`);
  }
  return normalized;
}

function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export class TerminalService {
  private readonly defaultCwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly nodePty: NodePtyModule;
  private readonly nodePtyPackageRoot?: string;
  private readonly chmod: (filePath: string, mode: number) => void;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly dataListeners = new Set<TerminalDataListener>();
  private readonly exitListeners = new Set<TerminalExitListener>();

  constructor(options: TerminalServiceOptions = {}) {
    this.defaultCwd = options.defaultCwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.nodePty = options.nodePty ?? defaultNodePtyLoader();
    this.nodePtyPackageRoot = options.nodePtyPackageRoot;
    this.chmod = options.chmod ?? chmodSync;

    if (options.onData) this.dataListeners.add(options.onData);
    if (options.onExit) this.exitListeners.add(options.onExit);
  }

  onData(listener: TerminalDataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: TerminalExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  open(options: OpenTerminalOptions = {}): TerminalSessionInfo {
    const cwd = options.cwd ?? this.defaultCwd;
    const cols = normalizeDimension(options.cols, DEFAULT_COLS, 'cols');
    const rows = normalizeDimension(options.rows, DEFAULT_ROWS, 'rows');
    const shell = this.resolveShell();

    this.ensureMacSpawnHelperPermissions();

    const spawnOptions: IPtyForkOptions = {
      name: 'xterm-256color',
      cwd,
      env: this.buildEnvironment(shell.file),
      cols,
      rows,
    };
    const pty = this.nodePty.spawn(shell.file, shell.args, spawnOptions);
    const info: TerminalSessionInfo = {
      sessionId: createSessionId(),
      cwd,
      shell: shell.file,
      cols,
      rows,
    };
    const session: TerminalSession = { info, pty, closed: false };
    this.sessions.set(info.sessionId, session);

    pty.onData((data) => {
      if (session.closed) return;
      for (const listener of this.dataListeners) {
        try {
          listener(info.sessionId, data);
        } catch {
          // A consumer callback must not terminate PTY event delivery.
        }
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(info.sessionId);
      for (const listener of this.exitListeners) {
        try {
          listener(info.sessionId, exitCode, signal);
        } catch {
          // A consumer callback must not prevent other listeners from running.
        }
      }
    });

    return info;
  }

  write(sessionId: string, data: string): void {
    if (typeof data !== 'string' || data.length === 0) return;
    const session = this.getActiveSession(sessionId);
    if (!session) return;
    session.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.getActiveSession(sessionId);
    if (!session) return;
    const nextCols = normalizeDimension(cols, DEFAULT_COLS, 'cols');
    const nextRows = normalizeDimension(rows, DEFAULT_ROWS, 'rows');
    if (session.info.cols === nextCols && session.info.rows === nextRows) return;
    session.pty.resize(nextCols, nextRows);
    session.info.cols = nextCols;
    session.info.rows = nextRows;
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    this.sessions.delete(sessionId);
    try {
      session.pty.kill();
    } catch {
      // The PTY may already have exited.
    }
  }

  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId);
    }
  }

  private getActiveSession(sessionId: string): TerminalSession | undefined {
    const session = this.sessions.get(sessionId);
    return session && !session.closed ? session : undefined;
  }

  private resolveShell(): { file: string; args: string[] } {
    if (this.platform === 'win32') {
      const shell = this.env.COMSPEC || this.env.ComSpec || 'powershell.exe';
      return {
        file: shell,
        args: shell.toLowerCase().includes('powershell') ? ['-NoLogo'] : [],
      };
    }

    const shell = this.env.SHELL || (this.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    return { file: shell, args: [] };
  }

  private buildEnvironment(shell: string): Record<string, string> {
    const env: Record<string, string> = {
      ...toStringEnv(this.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'EasyView_Md',
      PROMPT_SP: '',
    };
    if (this.platform !== 'win32') env.SHELL = shell;
    return env;
  }

  private ensureMacSpawnHelperPermissions(): void {
    if (this.platform !== 'darwin') return;

    const packageRoot = this.nodePtyPackageRoot ?? this.resolveNodePtyPackageRoot();
    if (!packageRoot) return;

    const archDirectory = this.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    const helperPath = path.join(packageRoot, 'prebuilds', archDirectory, 'spawn-helper');
    if (existsSync(helperPath)) this.chmod(helperPath, 0o755);
  }

  private resolveNodePtyPackageRoot(): string | undefined {
    try {
      return path.dirname(nodeRequire.resolve('node-pty/package.json'))
        .replace('app.asar', 'app.asar.unpacked')
        .replace('node_modules.asar', 'node_modules.asar.unpacked');
    } catch {
      return undefined;
    }
  }
}

export function createTerminalService(options: TerminalServiceOptions = {}): TerminalService {
  return new TerminalService({
    defaultCwd: options.defaultCwd ?? os.homedir(),
    ...options,
  });
}
