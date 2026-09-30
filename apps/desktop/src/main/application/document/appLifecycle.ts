/**
 * Shared restart / close confirmation gate. Every restart entry (app menu,
 * Dock, Windows user task, second-instance RESTART_FLAG) must go through
 * requestRestart so dirty documents cannot be discarded silently.
 */
export interface RestartRequest {
  hasDirtyDocuments: boolean;
  confirmCloseAll(): Promise<boolean>;
  relaunch(): void;
}

export async function requestRestart(request: RestartRequest): Promise<boolean> {
  if (request.hasDirtyDocuments) {
    const confirmed = await request.confirmCloseAll();
    if (!confirmed) return false;
  }
  request.relaunch();
  return true;
}
