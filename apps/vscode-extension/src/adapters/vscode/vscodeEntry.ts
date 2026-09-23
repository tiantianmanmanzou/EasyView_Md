import type {
  EditorHostTransport,
  EditorToHostMessage,
  HostToEditorMessage,
} from '@easyview/contracts';
import type { VscodeEditorHostActionMessage } from './vscodeProtocol';
import { createEasyViewEditor } from '@easyview/editor-core';

interface VscodeWebviewApi {
  postMessage(message: EditorToHostMessage | VscodeEditorHostActionMessage): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}

declare function acquireVsCodeApi(): VscodeWebviewApi;

const vscodeApi = acquireVsCodeApi();
const transport: EditorHostTransport = {
  capabilities: {
    sourceMode: 'native',
    git: true,
    terminal: true,
      aiCommitMessage: true,
      aiChat: true,
      documentConversion: true,
    shortcutPersistence: true,
  },
  postMessage(message) {
    vscodeApi.postMessage(message);
  },
  subscribe(listener) {
    const handler = (event: MessageEvent<HostToEditorMessage>) => listener(event.data);
    window.addEventListener('message', handler);
    return {
      unsubscribe() {
        window.removeEventListener('message', handler);
      },
    };
  },
};

const editor = createEasyViewEditor({
  host: transport,
  hostActions: {
    openSourceDocument(request) {
      vscodeApi.postMessage({ type: 'vscode.openSourceDocument', request });
    },
    persistOpenEditorShortcut(shortcut) {
      vscodeApi.postMessage({ type: 'vscode.persistOpenEditorShortcut', shortcut });
    },
  },
});

const savedState = vscodeApi.getState<{ version?: number; scrollRatio?: number }>();
const scrollArea = document.getElementById('editor-scroll-area');
if (scrollArea) {
  if (typeof savedState?.scrollRatio === 'number') {
    requestAnimationFrame(() => {
      scrollArea.scrollTop = Math.max(0, (scrollArea.scrollHeight - scrollArea.clientHeight) * savedState.scrollRatio!);
    });
  }
  scrollArea.addEventListener('scroll', () => {
    const denominator = Math.max(1, scrollArea.scrollHeight - scrollArea.clientHeight);
    vscodeApi.setState({ version: 1, scrollRatio: scrollArea.scrollTop / denominator });
  }, { passive: true });
}
window.addEventListener('unload', () => editor.dispose(), { once: true });
