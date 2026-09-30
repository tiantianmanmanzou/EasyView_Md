import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { DesktopTabRegistry } from './DesktopTabRegistry';
import type { DesktopWindowContext } from '../host/windowContext';

export interface DesktopWindowSession {
  id: string;
  webContentsId: number;
  tabs: DesktopTabRegistry;
  context: DesktopWindowContext;
}

/** Routes every renderer request by webContents instead of a process-global window. */
export class DesktopWindowRegistry {
  private readonly byWebContents = new Map<number, DesktopWindowSession>();
  private readonly byId = new Map<string, DesktopWindowSession>();

  register(webContents: Pick<WebContents, 'id'>, context: DesktopWindowContext): DesktopWindowSession {
    const session: DesktopWindowSession = { id: context.id, webContentsId: webContents.id, tabs: context.tabs, context };
    this.byWebContents.set(webContents.id, session);
    this.byId.set(session.id, session);
    return session;
  }

  unregister(webContents: Pick<WebContents, 'id'>): void {
    const session = this.byWebContents.get(webContents.id);
    if (!session) return;
    this.byWebContents.delete(webContents.id);
    this.byId.delete(session.id);
  }

  fromWebContents(webContents: Pick<WebContents, 'id'>): DesktopWindowSession | null {
    return this.byWebContents.get(webContents.id) ?? null;
  }

  get(windowId: string): DesktopWindowSession | null { return this.byId.get(windowId) ?? null; }

  values(): DesktopWindowSession[] { return [...this.byId.values()]; }
}
