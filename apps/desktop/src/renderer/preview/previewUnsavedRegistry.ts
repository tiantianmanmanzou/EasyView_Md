import type { PreviewController } from './PreviewController';

const controllers = new Set<PreviewController>();

/** Track live preview islands so main-process save-on-close can reach them. */
export function trackPreviewController(controller: PreviewController): () => void {
  controllers.add(controller);
  return () => { controllers.delete(controller); };
}

export async function savePreviewByPath(relativePath: string): Promise<boolean> {
  for (const controller of controllers) {
    if (controller.matchesPath(relativePath)) return controller.save();
  }
  return false;
}

export function clearPreviewDirtyByPath(relativePath: string): void {
  for (const controller of controllers) {
    if (controller.matchesPath(relativePath)) controller.setDirty(false);
  }
}

export function isAnyPreviewDirty(): boolean {
  for (const controller of controllers) {
    if (controller.isDirty()) return true;
  }
  return false;
}
