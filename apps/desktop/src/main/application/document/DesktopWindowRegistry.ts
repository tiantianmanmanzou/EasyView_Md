import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { DesktopTabRegistry } from './DesktopTabRegistry';

export interface DesktopWindowSession {
  id: string;
  webContentsId: number;
  tabs: DesktopTabRegistry;
}

/** Routes every renderer request by webContents instead of a process-global window. */
export class DesktopWindowRegistry {
  private readonly byWebContents = new Map<number, DesktopWindowSession>();
  private readonly byId = new Map<string, DesktopWindowSession>();

  register(webContents: Pick<WebContents, 'id'>, tabs = new DesktopTabRegistry(randomUUID())): DesktopWindowSession {
    const session: DesktopWindowSession = { id: tabs.snapshot().windowId, webContentsId: webContents.id, tabs };
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
}
