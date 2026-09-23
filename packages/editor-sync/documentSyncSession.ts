import { hashContent } from './contentHash';
import { applyTextPatches, minimalTextPatch, validatePatches, type TextOffsetPatch } from './textOffsetPatch';
import { rebasePatches } from './patchRebase';
import type { DocumentSyncState } from './documentSyncState';

export interface ApplyEditsMessage {
  type: 'applyEdits';
  documentId: string;
  baseRevision: number;
  clientEditId: string;
  edits: TextOffsetPatch[];
  resultHash: string;
}

export interface ResyncMessage {
  type: 'resyncRequired';
  documentId: string;
  revision: number;
  reason: string;
}

export type SyncOutboundMessage = ApplyEditsMessage | ResyncMessage;

export interface EditsAppliedAck {
  type: 'editsApplied';
  documentId: string;
  clientEditId: string;
  revision: number;
  resultHash: string;
}

export interface ExternalPatch {
  type: 'documentPatched';
  documentId: string;
  baseRevision: number;
  revision: number;
  edits: TextOffsetPatch[];
  resultHash: string;
}

export interface DocumentSyncSnapshot {
  documentId: string;
  revision: number;
  canonicalContent: string;
  state: DocumentSyncState;
  inFlight: ApplyEditsMessage | null;
  bufferedEdits: number;
}

export interface DocumentSyncSessionOptions {
  documentId: string;
  initialContent: string;
  initialRevision?: number;
  onSend?: (message: SyncOutboundMessage) => void;
}

interface InFlight {
  message: ApplyEditsMessage;
  contentBefore: string;
}

export class DocumentSyncSession {
  readonly documentId: string;
  private revision: number;
  private confirmedContent: string;
  private optimisticContent: string;
  private state: DocumentSyncState = 'synced';
  private inFlight: InFlight | null = null;
  private bufferedEditCount = 0;
  private nextEditId = 1;
  private readonly onSend?: (message: SyncOutboundMessage) => void;

  constructor(options: DocumentSyncSessionOptions) {
    this.documentId = options.documentId;
    this.revision = options.initialRevision ?? 0;
    this.confirmedContent = options.initialContent;
    this.optimisticContent = options.initialContent;
    this.onSend = options.onSend;
  }

  get snapshot(): DocumentSyncSnapshot {
    return {
      documentId: this.documentId,
      revision: this.revision,
      canonicalContent: this.optimisticContent,
      state: this.state,
      inFlight: this.inFlight?.message ?? null,
      bufferedEdits: this.bufferedEditCount,
    };
  }

  applyLocalEdits(edits: readonly TextOffsetPatch[]): ApplyEditsMessage | null {
    this.assertActive();
    const valid = validatePatches(edits, this.optimisticContent.length);
    if (valid.length === 0) return null;
    this.optimisticContent = applyTextPatches(this.optimisticContent, valid);
    if (this.inFlight) {
      this.bufferedEditCount += valid.length;
      this.state = 'awaitingAckWithBufferedEdits';
      return null;
    }
    return this.sendPendingEdits();
  }

  handleAck(ack: EditsAppliedAck): void {
    this.assertActive();
    if (ack.documentId !== this.documentId || !this.inFlight || ack.clientEditId !== this.inFlight.message.clientEditId) {
      this.requestResync('Unexpected edit acknowledgement');
      return;
    }
    if (ack.resultHash !== this.inFlight.message.resultHash || ack.revision <= this.revision) {
      this.requestResync('Edit acknowledgement hash mismatch');
      return;
    }
    this.confirmedContent = this.optimisticContentForInFlight();
    this.revision = ack.revision;
    this.inFlight = null;
    if (this.optimisticContent !== this.confirmedContent) {
      this.bufferedEditCount = 0;
      this.sendPendingEdits();
    } else {
      this.optimisticContent = this.confirmedContent;
      this.state = 'synced';
    }
  }

  handleExternalPatch(message: ExternalPatch): void {
    this.assertActive();
    if (message.documentId !== this.documentId || message.baseRevision !== this.revision || message.revision <= this.revision) {
      this.requestResync('External patch revision mismatch');
      return;
    }
    try {
      validatePatches(message.edits, this.confirmedContent.length);
      const nextConfirmed = applyTextPatches(this.confirmedContent, message.edits);
      if (hashContent(nextConfirmed) !== message.resultHash) throw new Error('External patch hash mismatch');
      if (this.inFlight || this.bufferedEditCount > 0) {
        const localDelta = minimalTextPatch(this.confirmedContent, this.optimisticContent);
        const rebased = rebasePatches(localDelta, message.edits);
        if (rebased.conflict) {
          this.state = 'conflict';
          return;
        }
        this.confirmedContent = nextConfirmed;
        this.revision = message.revision;
        this.optimisticContent = applyTextPatches(nextConfirmed, rebased.patches);
        if (this.inFlight) {
          this.inFlight = null;
          this.bufferedEditCount = 0;
          this.sendPendingEdits();
        }
      } else {
        this.confirmedContent = nextConfirmed;
        this.optimisticContent = nextConfirmed;
        this.revision = message.revision;
        this.state = 'synced';
      }
    } catch {
      this.requestResync('External patch validation failed');
    }
  }

  requestResync(reason: string): void {
    if (this.state === 'disposed' || this.state === 'resyncing') return;
    this.state = 'resyncing';
    this.onSend?.({ type: 'resyncRequired', documentId: this.documentId, revision: this.revision, reason });
  }

  applySnapshot(content: string, revision: number): void {
    this.assertActive();
    if (!Number.isInteger(revision) || revision < 0) throw new RangeError('Snapshot revision must be a non-negative integer');
    this.confirmedContent = content;
    this.optimisticContent = content;
    this.revision = revision;
    this.inFlight = null;
    this.bufferedEditCount = 0;
    this.state = 'synced';
  }

  markConflict(): void {
    this.assertActive();
    this.state = 'conflict';
  }

  dispose(): void {
    this.state = 'disposed';
    this.inFlight = null;
    this.bufferedEditCount = 0;
  }

  private sendPendingEdits(): ApplyEditsMessage {
    const edits = minimalTextPatch(this.confirmedContent, this.optimisticContent);
    const message: ApplyEditsMessage = {
      type: 'applyEdits',
      documentId: this.documentId,
      baseRevision: this.revision,
      clientEditId: `${this.documentId}:${this.nextEditId++}`,
      edits,
      resultHash: hashContent(this.optimisticContent),
    };
    this.inFlight = { message, contentBefore: this.confirmedContent };
    this.state = this.bufferedEditCount > 0 ? 'awaitingAckWithBufferedEdits' : 'awaitingAck';
    this.onSend?.(message);
    return message;
  }

  private optimisticContentForInFlight(): string {
    return applyTextPatches(this.inFlight!.contentBefore, this.inFlight!.message.edits);
  }

  private assertActive(): void {
    if (this.state === 'disposed') throw new Error('DocumentSyncSession is disposed');
  }
}

