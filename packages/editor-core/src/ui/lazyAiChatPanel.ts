import type { HostToEditorMessage } from '@easyview/contracts';
import type { AiChatPanel, AiChatPanelDeps } from './AiChatPanel';

export type { AiChatPanel, AiChatPanelDeps } from './AiChatPanel';

/**
 * Keeps the editor entry point free of the AI chat implementation and its
 * markdown renderer. The implementation is loaded only when the panel is
 * opened or an AI response arrives.
 */
export function createLazyAiChatPanel(deps: AiChatPanelDeps): AiChatPanel {
  let panel: AiChatPanel | undefined;
  let loadPromise: Promise<AiChatPanel | undefined> | undefined;
  let desiredOpen = false;
  let documentContextAvailable = true;
  let filePath = '';
  let disposed = false;

  const load = (): Promise<AiChatPanel | undefined> => {
    if (loadPromise) return loadPromise;
    loadPromise = import('./AiChatPanel')
      .then(({ createAiChatPanel }) => {
        if (disposed) return undefined;
        panel = createAiChatPanel(deps);
        panel.setDocumentContextAvailable(documentContextAvailable);
        panel.setFilePath(filePath);
        if (desiredOpen) panel.open();
        return panel;
      })
      .catch((error) => {
        loadPromise = undefined;
        console.error('[EasyView_Md] Failed to load AI chat panel:', error);
        return undefined;
      });
    return loadPromise;
  };

  const forwardAfterLoad = (action: (value: AiChatPanel) => void): void => {
    void load().then((value) => {
      if (value) action(value);
    });
  };

  return {
    toggle(): void {
      if (panel) {
        panel.toggle();
        desiredOpen = panel.isOpen();
        return;
      }
      desiredOpen = !desiredOpen;
      if (desiredOpen) forwardAfterLoad((value) => value.open());
    },
    open(): void {
      desiredOpen = true;
      if (panel) panel.open();
      else forwardAfterLoad((value) => value.open());
    },
    close(): void {
      desiredOpen = false;
      panel?.close();
    },
    isOpen(): boolean {
      return panel?.isOpen() ?? desiredOpen;
    },
    setFilePath(nextFilePath: string): void {
      filePath = nextFilePath;
      panel?.setFilePath(nextFilePath);
    },
    setDocumentContextAvailable(available: boolean): void {
      documentContextAvailable = available;
      panel?.setDocumentContextAvailable(available);
    },
    handleMessage(message: HostToEditorMessage): boolean {
      if (panel) return panel.handleMessage(message);
      if (!message?.type.startsWith('aiChat.')) return false;
      forwardAfterLoad((value) => {
        value.handleMessage(message);
      });
      return true;
    },
    destroy(): void {
      if (disposed) return;
      disposed = true;
      desiredOpen = false;
      panel?.destroy();
      panel = undefined;
    },
  };
}
