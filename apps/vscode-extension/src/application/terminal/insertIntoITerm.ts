import * as vscode from 'vscode';
import { getITermSnapshot, pasteIntoITermSession, type ITermSession } from './iTermBridge';

const rememberedSessionKey = 'easyview.iterm2.outlineTarget';

interface RememberedSession {
  sessionId: string;
  activeWindowId: number;
  windowIds: number[];
}

function sameWindows(previous: number[], current: number[]): boolean {
  if (previous.length !== current.length) return false;
  const orderedCurrent = [...current].sort((a, b) => a - b);
  return [...previous].sort((a, b) => a - b).every((id, index) => id === orderedCurrent[index]);
}

export async function insertIntoITerm(text: string, state: vscode.Memento): Promise<void> {
  try {
    if (process.platform !== 'darwin' || vscode.env.remoteName) {
      throw new Error('iTerm2 insertion requires a local macOS extension session.');
    }
    const { sessions, windowIds, activeWindowId } = await getITermSnapshot();
    if (!sessions.length) throw new Error('Open an iTerm2 session with Claude Code first.');
    const remembered = state.get<RememberedSession>(rememberedSessionKey);
    let target: ITermSession | undefined;
    if (remembered && activeWindowId === remembered.activeWindowId
      && sameWindows(remembered.windowIds, windowIds)) {
      target = sessions.find((session) => session.id === remembered.sessionId);
    }
    if (!target) {
      const picked = await vscode.window.showQuickPick(sessions.map((session) => ({
        label: session.name || 'iTerm2',
        description: `Window ${session.window} · Tab ${session.tab} · Pane ${session.pane}`,
        session,
      })), { title: 'Insert outline path into iTerm2', placeHolder: 'Select the session with Claude Code waiting for input' });
      target = picked?.session;
    }
    if (!target) return;
    await pasteIntoITermSession(target.id, text);
    await state.update(rememberedSessionKey, {
      sessionId: target.id,
      activeWindowId: target.windowId,
      windowIds,
    } satisfies RememberedSession);
  } catch (error) {
    await vscode.window.showErrorMessage(`Could not insert into iTerm2: ${error instanceof Error ? error.message : String(error)}`);
  }
}
