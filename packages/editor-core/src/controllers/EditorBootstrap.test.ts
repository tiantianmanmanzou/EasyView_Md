/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditorBootstrap } from './EditorBootstrap';

const setReadyState = (state: DocumentReadyState): void => {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value: state,
  });
};

afterEach(() => {
  setReadyState('complete');
});

describe('EditorBootstrap', () => {
  it('initializes immediately when the DOM is ready and forwards dispose once', () => {
    setReadyState('complete');
    const installStyles = vi.fn();
    const instance = {
      dispose: vi.fn(),
    };
    const initialize = vi.fn(() => instance);

    const bootstrap = new EditorBootstrap({
      installStyles,
      initialize,
    });

    const firstHandle = bootstrap.start();
    const secondHandle = bootstrap.start();

    expect(firstHandle).toBe(secondHandle);
    expect(installStyles).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);

    firstHandle.dispose();
    secondHandle.dispose();

    expect(instance.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancels DOMContentLoaded initialization when disposed before the DOM is ready', () => {
    setReadyState('loading');
    const installStyles = vi.fn();
    const initialize = vi.fn();
    const bootstrap = new EditorBootstrap({
      installStyles,
      initialize,
    });

    const handle = bootstrap.start();
    handle.dispose();
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(installStyles).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('initializes at most once and does not initialize after dispose', () => {
    setReadyState('loading');
    const installStyles = vi.fn();
    const initialize = vi.fn();
    const bootstrap = new EditorBootstrap({
      installStyles,
      initialize,
    });

    const handle = bootstrap.start();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    document.dispatchEvent(new Event('DOMContentLoaded'));
    handle.dispose();
    bootstrap.start();

    expect(installStyles).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('forwards disposal for an initialized instance only once', () => {
    setReadyState('complete');
    const installStyles = vi.fn();
    const initialize = vi.fn();
    const bootstrap = new EditorBootstrap({
      installStyles,
      initialize,
    });

    const handle = bootstrap.start();
    handle.dispose();

    expect(installStyles).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
