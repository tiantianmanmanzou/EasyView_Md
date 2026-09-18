import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';

const execFileAsync = promisify(execFile);

/**
 * Host-side counterpart of VS Code explorer "Open With..." OS application picker.
 * Windows uses the shell OpenAs dialog; macOS uses "choose application";
 * other platforms fall back to the default handler.
 */
export async function openWithSystemApplicationPicker(
  absolutePath: string,
  owner: BrowserWindow | null = null,
): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('rundll32', ['shell32.dll,OpenAs_RunDLL', absolutePath], { windowsHide: true });
    return;
  }

  if (process.platform === 'darwin') {
    const script = [
      'set chosenApp to choose application with prompt "Open With…"',
      `set theFile to POSIX file ${appleScriptString(absolutePath)}`,
      'tell application chosenApp to open theFile',
    ].join('\n');
    try {
      await execFileAsync('osascript', ['-e', script]);
    } catch (error) {
      // User cancelled the application chooser — not an error to surface.
      if (isAppleScriptCancel(error)) return;
      throw error;
    }
    return;
  }

  if (owner) {
    await dialog.showMessageBox(owner, {
      type: 'info',
      message: 'Choose Application is not available on this platform.',
      detail: 'The file will open with the default application instead.',
    });
  }
  const openError = await shell.openPath(absolutePath);
  if (openError) throw new Error(openError);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isAppleScriptCancel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /User canceled|unbekannt|cancelled|canceled|-128/i.test(message);
}
