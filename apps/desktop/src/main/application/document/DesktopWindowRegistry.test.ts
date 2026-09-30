import { describe, expect, it } from 'vitest';
import { createDesktopWindowContext } from '../host/windowContext';
import { DesktopWindowRegistry } from './DesktopWindowRegistry';

describe('DesktopWindowRegistry', () => {
  it('routes renderer identities to isolated window contexts', () => {
    const registry = new DesktopWindowRegistry();
    const first = createDesktopWindowContext('window-a');
    const second = createDesktopWindowContext('window-b');
    const firstSession = registry.register({ id: 11 }, first);
    const secondSession = registry.register({ id: 22 }, second);

    first.tabs.openEditor('/tmp/a.md', 'a.md', 'a');
    second.tabs.openEditor('/tmp/b.md', 'b.md', 'b');

    expect(registry.fromWebContents({ id: 11 })?.context).toBe(first);
    expect(registry.fromWebContents({ id: 22 })?.context).toBe(second);
    expect(firstSession.tabs.snapshot().tabs.map((tab) => tab.id)).toEqual(['a']);
    expect(secondSession.tabs.snapshot().tabs.map((tab) => tab.id)).toEqual(['b']);
    expect(first.documentSessions).not.toBe(second.documentSessions);
    expect(first.workspaceCore).not.toBe(second.workspaceCore);
  });
});
