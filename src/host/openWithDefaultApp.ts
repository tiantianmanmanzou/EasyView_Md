import { spawn } from 'child_process';

/** Open a file with the operating system's default application. */
export function openWithDefaultApp(fsPath: string): void {
  if (process.platform === 'win32') {
    spawn('explorer', [fsPath], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    spawn('open', [fsPath], { detached: true, stdio: 'ignore' });
  } else {
    spawn('xdg-open', [fsPath], { detached: true, stdio: 'ignore' });
  }
}
