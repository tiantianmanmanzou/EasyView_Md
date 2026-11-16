import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';
import { PreviewController } from './PreviewController';
import { PreviewShell } from './PreviewShell';
import { trackPreviewController } from './previewUnsavedRegistry';

export interface PreviewIsland {
  open(relativePath: string, options?: { force?: boolean }): Promise<boolean>;
  /** Returns false when the user cancels leaving unsaved edits. */
  close(): Promise<boolean>;
  dispose(): void;
}

export function createPreviewIsland(container: HTMLElement, api: EasyViewDesktopApi): PreviewIsland {
  const controller = new PreviewController(api);
  const untrack = trackPreviewController(controller);
  const root: Root = createRoot(container);
  const render = () => root.render(React.createElement(PreviewShell, { controller }));
  const unsubscribe = controller.subscribe(render);
  render();

  return {
    async open(relativePath: string, options?: { force?: boolean }): Promise<boolean> {
      return (await controller.open(relativePath, options)) !== null;
    },
    async close(): Promise<boolean> {
      if (!(await controller.ensureClean())) return false;
      await controller.closeForced();
      return true;
    },
    dispose(): void {
      untrack();
      unsubscribe();
      controller.dispose();
      root.unmount();
    },
  };
}
