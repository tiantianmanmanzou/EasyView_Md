import type {
  EditorHostTransport,
  HostToEditorMessage,
  EditorToHostMessage,
} from '@easyview/contracts';
import type { VscodeEditorHostActionMessage } from './vscodeProtocol';
import { createEasyViewEditor } from '@easyview/editor-core';

interface VscodeWebviewApi {
  postMessage(message: EditorToHostMessage | VscodeEditorHostActionMessage): void;
}

declare function acquireVsCodeApi(): VscodeWebviewApi;

declare global {
  interface Window {
    __INITIAL_DATA__?: HostToEditorMessage;
  }
}

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

const initialMessage = window.__INITIAL_DATA__;
delete window.__INITIAL_DATA__;

const editor = createEasyViewEditor({
  host: transport,
  initialMessage,
  hostActions: {
    openSourceDocument(request) {
      vscodeApi.postMessage({ type: 'vscode.openSourceDocument', request });
    },
    persistOpenEditorShortcut(shortcut) {
      vscodeApi.postMessage({ type: 'vscode.persistOpenEditorShortcut', shortcut });
    },
  },
});

window.addEventListener('unload', () => editor.dispose(), { once: true });
