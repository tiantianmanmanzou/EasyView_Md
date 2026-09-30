import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export interface ITermSession { id: string; name: string; windowId: number; window: number; tab: number; pane: number }
export interface ITermSnapshot { sessions: ITermSession[]; windowIds: number[]; activeWindowId: number | null }

// Arguments are data, never interpolated into executable script source.
const script = `function run(argv) {
  const app = Application('com.googlecode.iterm2');
  if (!app.running()) throw new Error('Open iTerm2 and Claude Code first.');
  const sessions = [];
  const windows = app.windows();
  const windowIds = windows.map(w => w.id());
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    const tabs = w.tabs();
    for (let ti = 0; ti < tabs.length; ti++) {
      const t = tabs[ti];
      const panes = t.sessions();
      for (let pi = 0; pi < panes.length; pi++) {
        const s = panes[pi];
        if (argv[0] === 'paste' && s.id() === argv[1]) {
          s.write({text: '\\x1b[200~' + argv[2] + '\\x1b[201~', newline: false});
          t.select();
          s.select();
          w.select();
          app.activate();
          return '';
        }
        sessions.push({id: s.id(), name: s.name(), windowId: w.id(), window: wi + 1, tab: ti + 1, pane: pi + 1});
      }
    }
  }
  if (argv[0] === 'paste') throw new Error('The selected iTerm2 session has closed. Select an open session.');
  return JSON.stringify({sessions, windowIds, activeWindowId: windowIds[0] ?? null});
}`;

async function run(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: 15000 });
  return stdout.trim();
}

export async function getITermSnapshot(): Promise<ITermSnapshot> {
  return JSON.parse(await run('list'));
}

export async function pasteIntoITermSession(id: string, text: string): Promise<void> {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('Outline path contains unsupported control characters.');
  await run('paste', id, text);
}
