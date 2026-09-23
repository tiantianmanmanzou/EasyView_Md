import type { EditorToHostMessage, HostToEditorMessage } from '@easyview/contracts';
import type { TerminalAppearance, TerminalModal } from './TerminalModal';

export type { TerminalAppearance, TerminalModal } from './TerminalModal';

type TerminalDeps = {
  postMessage: (message: EditorToHostMessage) => void;
  appearance?: TerminalAppearance;
  onVisibilityChange?: (visible: boolean) => void;
};

/** Loads xterm and the terminal UI only after the terminal is first used. */
export function createLazyTerminalModal(options: TerminalDeps): TerminalModal {
  let modal: TerminalModal | undefined;
  let loadPromise: Promise<TerminalModal | undefined> | undefined;
  let desiredOpen = false;
  let appearance = options.appearance;
  let disposed = false;

  const load = (): Promise<TerminalModal | undefined> => {
    if (loadPromise) return loadPromise;
    loadPromise = import('./TerminalModal')
      .then(({ createTerminalModal }) => {
        if (disposed) return undefined;
        modal = createTerminalModal({ ...options, appearance });
        if (desiredOpen) modal.open();
        return modal;
      })
      .catch((error) => {
        loadPromise = undefined;
        console.error('[EasyView_Md] Failed to load terminal modal:', error);
        return undefined;
      });
    return loadPromise;
  };

  const forwardAfterLoad = (action: (value: TerminalModal) => void): void => {
    void load().then((value) => {
      if (value) action(value);
    });
  };

  return {
    toggle(): void {
      if (modal) {
        modal.toggle();
        desiredOpen = modal.isOpen();
        return;
      }
      desiredOpen = !desiredOpen;
      if (desiredOpen) forwardAfterLoad((value) => value.open());
    },
    open(): void {
      desiredOpen = true;
      if (modal) modal.open();
      else forwardAfterLoad((value) => value.open());
    },
    close(): void {
      desiredOpen = false;
      modal?.close();
    },
    isOpen(): boolean {
      return modal?.isOpen() ?? desiredOpen;
    },
    updateAppearance(nextAppearance?: TerminalAppearance): void {
      appearance = { ...appearance, ...(nextAppearance ?? {}) };
      modal?.updateAppearance(nextAppearance);
    },
    handleMessage(message: HostToEditorMessage): boolean {
      if (modal) return modal.handleMessage(message);
      if (!message?.type.startsWith('terminal')) return false;
      forwardAfterLoad((value) => {
        value.handleMessage(message);
      });
      return true;
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      desiredOpen = false;
      modal?.destroy();
      modal = undefined;
    },
  };
}
