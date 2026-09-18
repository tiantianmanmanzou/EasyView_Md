import type { HostToEditorMessage, EditorToHostMessage } from '../messages/editor-messages';
import type { EditorHostCapabilities } from '../capabilities/editor-host-capabilities';
export type { EditorHostCapabilities } from '../capabilities/editor-host-capabilities';

export interface EditorHostSubscription {
  unsubscribe(): void;
}

export type EditorHostMessageListener = (message: HostToEditorMessage) => void;

/** Request data shared by source-document adapters without exposing host-specific messages. */
export interface EditorSourceDocumentRequest {
  content: string;
  fullWidth: boolean;
  tocVisible: boolean;
  tableWrap: boolean;
  line: number;
  character: number;
}

export interface EditorHostTransport {
  readonly capabilities: EditorHostCapabilities;
  postMessage(message: EditorToHostMessage): void | Promise<void>;
  subscribe(listener: EditorHostMessageListener): EditorHostSubscription;
}
