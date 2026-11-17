/** @vitest-environment happy-dom */
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewHost } from '../types';
import { usePreviewUnsaved } from './usePreviewUnsaved';

function Harness({
  host,
  dirty,
  save,
}: {
  host: PreviewHost;
  dirty: boolean;
  save: () => Promise<void>;
}): null {
  usePreviewUnsaved(host, dirty, save);
  return null;
}

describe('usePreviewUnsaved', () => {
  const nodes: HTMLElement[] = [];
  afterEach(() => {
    for (const node of nodes) {
      node.remove();
    }
    nodes.length = 0;
  });

  it('reports dirty and registers a save handler', async () => {
    const setDirty = vi.fn();
    let registered: (() => Promise<void>) | null = null;
    const host: PreviewHost = {
      getState: () => ({ descriptor: null, status: 'idle', error: null }),
      subscribe: () => () => {},
      setDirty,
      registerSaveHandler: (save) => {
        registered = save;
        return () => { if (registered === save) registered = null; };
      },
    };
    const save = vi.fn(async () => {});
    const mount = document.createElement('div');
    document.body.append(mount);
    nodes.push(mount);
    const root = createRoot(mount);
    flushSync(() => {
      root.render(React.createElement(Harness, { host, dirty: true, save }));
    });
    expect(setDirty).toHaveBeenCalledWith(true);
    expect(registered).toBeTypeOf('function');
    await registered!();
    expect(save).toHaveBeenCalledOnce();
    flushSync(() => {
      root.render(React.createElement(Harness, { host, dirty: false, save }));
    });
    expect(setDirty).toHaveBeenCalledWith(false);
    flushSync(() => root.unmount());
  });
});
