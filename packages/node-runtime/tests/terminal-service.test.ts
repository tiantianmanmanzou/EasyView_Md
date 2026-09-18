import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IPty, IDisposable } from 'node-pty';
import { TerminalService } from '../src/terminal/terminal-service';

class FakePty implements Partial<IPty> {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number; signal?: number }) => void;

  onData(listener: (data: string) => void): IDisposable {
    this.dataListener = listener;
    return { dispose: () => { this.dataListener = undefined; } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable {
    this.exitListener = listener;
    return { dispose: () => { this.exitListener = undefined; } };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    this.exitListener?.({ exitCode, signal });
  }
}

function createNodePty(fake: FakePty, spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }>) {
  return {
    spawn: vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ file, args, options });
      return fake;
    }),
  } as unknown as typeof import('node-pty');
}

describe('TerminalService', () => {
  it('lets Main choose cwd while resolving the shell and environment internally', () => {
    const pty = new FakePty();
    const spawnCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const service = new TerminalService({
      platform: 'linux',
      defaultCwd: '/main/default',
      env: { SHELL: '/bin/fish', USER: 'tester' },
      nodePty: createNodePty(pty, spawnCalls),
    });

    const info = service.open({ cwd: '/main/document', cols: 80, rows: 24 });

    expect(info.cwd).toBe('/main/document');
    expect(spawnCalls[0]).toMatchObject({ file: '/bin/fish', args: [] });
    expect(spawnCalls[0].options).toMatchObject({
      cwd: '/main/document',
      cols: 80,
      rows: 24,
      env: {
        USER: 'tester',
        SHELL: '/bin/fish',
        TERM: 'xterm-256color',
        TERM_PROGRAM: 'EasyView_Md',
      },
    });
    expect(spawnCalls[0].options).not.toHaveProperty('shell');
    expect(spawnCalls[0].options).not.toHaveProperty('executable');
  });

  it('supports data, exit, write, resize, close and disposeAll', () => {
    const first = new FakePty();
    const second = new FakePty();
    const spawned = [first, second];
    const data = vi.fn();
    const exit = vi.fn();
    const service = new TerminalService({
      platform: 'linux',
      nodePty: {
        spawn: vi.fn(() => spawned.shift()!),
      } as unknown as typeof import('node-pty'),
      onData: data,
      onExit: exit,
    });

    const firstInfo = service.open();
    const secondInfo = service.open();
    first.emitData('hello');
    service.write(firstInfo.sessionId, 'ls\n');
    service.resize(firstInfo.sessionId, 100, 30);
    first.emitExit(0, 0);
    service.close(firstInfo.sessionId);
    service.disposeAll();

    expect(data).toHaveBeenCalledWith(firstInfo.sessionId, 'hello');
    expect(exit).toHaveBeenCalledWith(firstInfo.sessionId, 0, 0);
    expect(first.writes).toEqual(['ls\n']);
    expect(first.resizes).toEqual([[100, 30]]);
    expect(first.killed).toBe(false);
    expect(second.killed).toBe(true);
    expect(() => service.write(secondInfo.sessionId, 'ignored')).not.toThrow();
  });

  it('uses platform shells without accepting a renderer-provided executable', () => {
    const windowsPty = new FakePty();
    const windowsCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const windows = new TerminalService({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      nodePty: createNodePty(windowsPty, windowsCalls),
    });
    windows.open({ cwd: 'C:\\workspace' });

    expect(windowsCalls[0]).toMatchObject({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
    });
    expect(windowsCalls[0].options).not.toHaveProperty('executable');

    const powershellPty = new FakePty();
    const powershellCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    new TerminalService({
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
      nodePty: createNodePty(powershellPty, powershellCalls),
    }).open();
    expect(powershellCalls[0].args).toEqual(['-NoLogo']);
  });

  it('sets macOS spawn-helper permissions for the active architecture', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easyview-terminal-service-'));
    const helperPath = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    await mkdir(path.dirname(helperPath), { recursive: true });
    await writeFile(helperPath, 'helper');
    const chmod = vi.fn();
    const pty = new FakePty();

    try {
      new TerminalService({
        platform: 'darwin',
        arch: 'arm64',
        nodePtyPackageRoot: root,
        chmod,
        nodePty: createNodePty(pty, []),
      }).open();
      expect(chmod).toHaveBeenCalledWith(helperPath, 0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid dimensions before spawning', () => {
    const spawn = vi.fn();
    const service = new TerminalService({
      nodePty: { spawn } as unknown as typeof import('node-pty'),
    });

    expect(() => service.open({ cols: 0 })).toThrow(/cols/);
    expect(() => service.open({ rows: Number.NaN })).toThrow(/rows/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
