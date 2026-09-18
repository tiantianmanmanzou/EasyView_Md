/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const terminals: MockTerminal[] = [];
  const addons: MockFitAddon[] = [];

  class MockFitAddon {
    dispose = vi.fn();

    constructor() {
      addons.push(this);
    }

    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  }

  class MockTerminal {
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    options: Record<string, unknown> = {};
    dataListener: ((data: string) => void) | null = null;
    dispose = vi.fn();
    focus = vi.fn();
    clear = vi.fn();
    refresh = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    loadAddon = vi.fn();
    open = vi.fn((host: HTMLElement) => {
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      host.appendChild(this.element);
    });
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListener = listener;
      return { dispose: vi.fn() };
    });
    write = vi.fn();
    writeln = vi.fn();

    constructor() {
      terminals.push(this);
    }
  }

  class MockResizeObserver {
    static instances: MockResizeObserver[] = [];
    observe = vi.fn();
    disconnect = vi.fn();

    constructor() {
      MockResizeObserver.instances.push(this);
    }
  }

  return { terminals, addons, MockTerminal, MockFitAddon, MockResizeObserver };
});

vi.mock('@xterm/xterm', () => ({ Terminal: mocks.MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: mocks.MockFitAddon }));

import { createTerminalModal } from './TerminalModal';

const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalResizeObserver = window.ResizeObserver;

function installAnimationFrameMocks(): void {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  window.cancelAnimationFrame = vi.fn((id: number) => {
    callbacks.delete(id);
  });
}

describe('TerminalModal lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.terminals.length = 0;
    mocks.addons.length = 0;
    mocks.MockResizeObserver.instances.length = 0;
    window.ResizeObserver = mocks.MockResizeObserver as unknown as typeof ResizeObserver;
    installAnimationFrameMocks();
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    window.ResizeObserver = originalResizeObserver;
    document.body.innerHTML = '';
  });

  it('destroys terminal resources and sends one close message for an active session', () => {
    const postMessage = vi.fn();
    const modal = createTerminalModal({ postMessage });

    modal.open();
    expect(modal.isOpen()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'openTerminal' });
    expect(document.querySelector('.easyview-terminal-modal')).not.toBeNull();

    modal.handleMessage({
      type: 'terminalOpened',
      sessionId: 'session-1',
      cwd: '/tmp',
      platform: 'darwin',
      homeDir: '/Users/test',
    });

    const terminal = mocks.terminals[0];
    const fitAddon = mocks.addons[0];
    const resizeObserver = mocks.MockResizeObserver.instances[0];
    expect(terminal).toBeDefined();
    expect(fitAddon).toBeDefined();
    expect(resizeObserver).toBeDefined();

    modal.destroy();
    modal.destroy();

    const terminalMessages = postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'openTerminal' || message.type === 'terminalClose');
    expect(terminalMessages).toEqual([
      { type: 'openTerminal' },
      { type: 'terminalClose' },
    ]);
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(fitAddon.dispose).toHaveBeenCalledOnce();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(document.querySelector('.easyview-terminal-modal')).toBeNull();
    expect(modal.isOpen()).toBe(false);
  });

  it('keeps open, toggle, and message behavior before destroy and becomes inert after destroy', () => {
    const postMessage = vi.fn();
    const modal = createTerminalModal({ postMessage });

    modal.toggle();
    expect(modal.isOpen()).toBe(true);
    modal.toggle();
    expect(modal.isOpen()).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({ type: 'terminalClose' });

    modal.open();
    expect(postMessage).toHaveBeenCalledWith({ type: 'openTerminal' });
    expect(
      modal.handleMessage({
        type: 'terminalData',
        sessionId: 'missing-session',
        data: 'ignored until terminal is opened',
      }),
    ).toBe(true);

    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    modal.destroy();

    expect(removeEventListener).toHaveBeenCalledWith(
      'inlinemd:themeChanged',
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(modal.handleMessage({ type: 'terminalError', message: 'late error' })).toBe(false);

    const messageCount = postMessage.mock.calls.length;
    modal.open();
    modal.toggle();
    modal.updateAppearance({ fontSize: 14 });
    expect(postMessage).toHaveBeenCalledTimes(messageCount);
  });

  it('does not send terminalClose when destroyed before opening', () => {
    const postMessage = vi.fn();
    const modal = createTerminalModal({ postMessage });

    modal.destroy();

    expect(postMessage).not.toHaveBeenCalledWith({ type: 'terminalClose' });
    expect(document.querySelector('.easyview-terminal-modal')).toBeNull();
  });
});
