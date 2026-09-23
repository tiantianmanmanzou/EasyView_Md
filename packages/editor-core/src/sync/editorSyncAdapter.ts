import type { EditorToHostMessage, HostToEditorMessage, TextOffsetPatchPayload } from '@easyview/contracts';
import {
  DocumentSyncSession,
  hashContent,
  minimalTextPatch,
  type ExternalPatch,
} from '@easyview/editor-sync';

type LocalSource = 'local' | 'undo' | 'redo';

export interface EditorSyncAdapterOptions {
  postMessage: (message: EditorToHostMessage) => void;
  getSettings: () => { fullWidth: boolean; tocVisible: boolean; tableWrap: boolean };
  onSnapshot: (content: string, revision: number, message: Extract<HostToEditorMessage, { type: 'documentSnapshot' }>) => void;
  onExternalContent: (content: string, patches: TextOffsetPatchPayload[], revision: number) => boolean;
}

/** Webview-side protocol adapter. It is the only owner of optimistic document state. */
export class EditorSyncAdapter {
  private session: DocumentSyncSession | null = null;
  private readonly options: EditorSyncAdapterOptions;
  private outboundSource: LocalSource = 'local';

  constructor(options: EditorSyncAdapterOptions) {
    this.options = options;
  }

  private send(message: Parameters<NonNullable<ConstructorParameters<typeof DocumentSyncSession>[0]['onSend']>>[0]): void {
    if (message.type === 'applyEdits') {
      this.options.postMessage({ type: 'applyEdits', documentId: message.documentId, clientEditId: message.clientEditId, baseRevision: message.baseRevision, edits: message.edits, resultHash: message.resultHash, source: this.outboundSource, ...this.options.getSettings() });
    } else {
      this.options.postMessage({ type: 'requestResync', documentId: message.documentId, revision: message.revision, reason: message.reason });
    }
  }
  get revision(): number { return this.session?.snapshot.revision ?? 0; }
  get documentId(): string | null { return this.session?.documentId ?? null; }
  get content(): string { return this.session?.snapshot.canonicalContent ?? ''; }
  get isReady(): boolean { return this.session !== null; }

  applyLocalContent(content: string, source: LocalSource = 'local'): void {
    if (!this.session) return;
    const edits = minimalTextPatch(this.session.snapshot.canonicalContent, content);
    if (edits.length === 0) return;
    this.outboundSource = source;
    this.session.applyLocalEdits(edits);
  }

  handleMessage(message: HostToEditorMessage): boolean {
    switch (message.type) {
      case 'documentSnapshot': {
        if (!this.session || this.session.documentId !== message.documentId) {
          this.session = new DocumentSyncSession({ documentId: message.documentId, initialContent: message.content, initialRevision: message.revision, onSend: (outbound) => this.send(outbound) });
        } else {
          this.session.applySnapshot(message.content, message.revision);
        }
        this.options.onSnapshot(message.content, message.revision, message);
        this.options.postMessage({ type: 'snapshotApplied', documentId: message.documentId, revision: message.revision, contentHash: hashContent(message.content) });
        return true;
      }
      case 'editsApplied':
        this.session?.handleAck(message);
        return true;
      case 'documentPatched': {
        if (!this.session) return true;
        const before = this.session.snapshot.canonicalContent;
        const external: ExternalPatch = { type: 'documentPatched', documentId: message.documentId, baseRevision: message.baseRevision, revision: message.revision, edits: message.edits, resultHash: message.resultHash };
        this.session.handleExternalPatch(external);
        const snapshot = this.session.snapshot;
        if (snapshot.state === 'resyncing') return true;
        if (snapshot.state === 'conflict') { this.session.requestResync('External patch conflicts with local edits'); return true; }
        const visiblePatches = minimalTextPatch(before, snapshot.canonicalContent);
        if (!this.options.onExternalContent(snapshot.canonicalContent, visiblePatches, message.revision)) {
          this.session.requestResync('External patch requires a structural snapshot');
        }
        return true;
      }
      case 'resyncRequired':
        this.session?.requestResync(message.reason);
        return true;
      default:
        return false;
    }
  }

  requestResync(reason: string): void { this.session?.requestResync(reason); }
  dispose(): void { this.session?.dispose(); this.session = null; }
}
