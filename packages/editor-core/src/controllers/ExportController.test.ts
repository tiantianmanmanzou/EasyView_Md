/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostMessageListener, EditorHostSubscription, EditorHostTransport } from '@easyview/contracts';

import { ExportController } from './ExportController';

type Resolver = (originalSrc: string) => Promise<string | null>;

type ImageResolutionWindow = Window & {
  __easyviewGetImageDataUrl?: Resolver;
};

function createHost() {
  const listeners = new Set<EditorHostMessageListener>();
  const unsubscribe = vi.fn();
  const postMessage = vi.fn();
  const host: EditorHostTransport = {
    capabilities: {
      sourceMode: 'embedded',
      git: false,
      terminal: false,
      aiCommitMessage: false,
      aiChat: false,
      documentConversion: false,
      shortcutPersistence: false,
    },
    postMessage,
    subscribe(listener): EditorHostSubscription {
      listeners.add(listener);
      return {
        unsubscribe: vi.fn(() => {
          unsubscribe();
          listeners.delete(listener);
        }),
      };
    },
  };

  return {
    host,
    listeners,
    postMessage,
    unsubscribe,
  };
}

function createController(host: EditorHostTransport): ExportController {
  return new ExportController({
    editor: { getMarkdown: () => '' } as never,
    view: {} as never,
    fileHeader: { el: document.createElement('div') } as never,
    host,
    isSourceMode: () => false,
    getSourceEditor: () => null,
  });
}

afterEach(() => {
  delete (window as ImageResolutionWindow).__easyviewGetImageDataUrl;
  vi.useRealTimers();
});

describe('ExportController image resolution lifecycle', () => {
  it('owns and restores the global resolver and removes the fallback listener on dispose', async () => {
    const previousResolver = vi.fn<Resolver>(() => Promise.resolve('previous'));
    const target = window as ImageResolutionWindow;
    target.__easyviewGetImageDataUrl = previousResolver;
    const { host, postMessage, unsubscribe } = createHost();
    const controller = createController(host);
    const apply = vi.fn();

    controller.installImageResolutionBridge();
    controller.installImageResolutionBridge();
    const resolver = target.__easyviewGetImageDataUrl;
    expect(resolver).toBeDefined();

    const request = resolver!('image.png');
    window.dispatchEvent(
      new CustomEvent('inlinemd:resolveImageFallback', {
        detail: { originalSrc: 'fallback.png', apply },
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);

    controller.dispose();
    controller.dispose();

    expect(target.__easyviewGetImageDataUrl).toBe(previousResolver);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
    expect(await request).toBeNull();

    window.dispatchEvent(
      new CustomEvent('inlinemd:resolveImageFallback', {
        detail: { originalSrc: 'after-dispose.png', apply },
      }),
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('cleans a pending host subscription and timeout and ignores a late response after dispose', async () => {
    vi.useFakeTimers();
    const { host, listeners, postMessage, unsubscribe } = createHost();
    const controller = createController(host);

    const request = controller.requestImageBase64FromHost('image.png', 1000);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    const subscribedListeners = [...listeners];
    controller.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(await request).toBeNull();

    for (const listener of subscribedListeners) {
      listener({ type: 'imageBase64Response', requestId: 'late', base64: 'late-data' });
    }
    vi.advanceTimersByTime(1000);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('cleans the timeout when a response arrives synchronously', async () => {
    vi.useFakeTimers();
    const listeners = new Set<EditorHostMessageListener>();
    const host: EditorHostTransport = {
      capabilities: {
      sourceMode: 'embedded',
      git: false,
      terminal: false,
      aiCommitMessage: false,
      aiChat: false,
      documentConversion: false,
      shortcutPersistence: false,
    },
      postMessage: vi.fn((message) => {
        if (message.type !== 'getImageBase64') return;
        for (const listener of listeners) {
          listener({ type: 'imageBase64Response', requestId: message.requestId, base64: 'data:image/png;base64,ok' });
        }
      }),
      subscribe(listener) {
        listeners.add(listener);
        return { unsubscribe: vi.fn(() => listeners.delete(listener)) };
      },
    };
    const controller = createController(host);

    await expect(controller.requestImageBase64FromHost('image.png', 1000)).resolves.toBe('data:image/png;base64,ok');
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
});
