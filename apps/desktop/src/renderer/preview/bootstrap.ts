import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EasyViewDesktopApi } from '../../preload/desktopApi';
import { PreviewController } from './PreviewController';
import { PreviewShell } from './PreviewShell';

export interface PreviewIsland {
  open(relativePath: string): Promise<boolean>;
  close(): Promise<void>;
  dispose(): void;
}

export function createPreviewIsland(container: HTMLElement, api: EasyViewDesktopApi): PreviewIsland {
  const controller = new PreviewController(api);
  const root: Root = createRoot(container);
  const render = () => root.render(React.createElement(PreviewShell, { controller }));
  const unsubscribe = controller.subscribe(render);
  render();

  async function close(): Promise<void> {
    await controller.close();
  }

  return {
    async open(relativePath: string): Promise<boolean> {
      return (await controller.open(relativePath)) !== null;
    },
    close,
    dispose(): void {
      unsubscribe();
      controller.dispose();
      root.unmount();
    },
  };
}
