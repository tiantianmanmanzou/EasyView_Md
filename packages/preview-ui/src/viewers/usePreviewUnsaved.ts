import * as React from 'react';
import type { PreviewHost } from '../types';

/**
 * Keep the host informed of unsaved edits and register the viewer's save
 * callback so close/quit can persist before tearing the session down.
 */
export function usePreviewUnsaved(
  host: PreviewHost | null | undefined,
  dirty: boolean,
  save: () => Promise<void>,
): void {
  const saveRef = React.useRef(save);
  saveRef.current = save;

  React.useEffect(() => {
    host?.setDirty?.(dirty);
    return () => { host?.setDirty?.(false); };
  }, [host, dirty]);

  React.useEffect(() => {
    if (!host?.registerSaveHandler) return undefined;
    return host.registerSaveHandler(async () => {
      await saveRef.current();
    });
  }, [host]);
}
