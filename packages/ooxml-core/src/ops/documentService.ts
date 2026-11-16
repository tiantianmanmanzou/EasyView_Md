import { createHash } from 'node:crypto';
import { OpcPackage } from '../opc/package';
import type { ChangeEvent, DocumentOp, Locator, OpSource, Rev } from './types';

export type FormatAdapter = {
  kind: 'xlsx' | 'docx' | 'pptx' | 'generic';
  summary(pkg: OpcPackage): Promise<unknown>;
  read(pkg: OpcPackage, locator: Locator): Promise<unknown>;
  /** Apply ops against the open package; return dirty part names. */
  apply(pkg: OpcPackage, ops: DocumentOp[]): Promise<string[]>;
};

export interface DocumentServiceOptions {
  adapter: FormatAdapter;
  /** Absolute or logical path for conflict checks / save. */
  filePath?: string;
  /** Called by save() when the caller supplies bytes write. */
  writeBytes?: (bytes: Uint8Array) => Promise<void>;
  /** Optional external fingerprint provider (disk mtime/hash). */
  readExternalFingerprint?: () => Promise<string | null>;
}

/**
 * Unified document session: query / apply / save / subscribe.
 * Format-specific behavior lives in the adapter; package + rev live here.
 */
export class DocumentService {
  private revCounter: Rev = 0;
  private fingerprint: string;
  private readonly listeners = new Set<(event: ChangeEvent) => void>();
  private readonly undoStack: Array<{ source: OpSource; parts: Map<string, Uint8Array> }> = [];

  private constructor(
    private pkg: OpcPackage,
    private readonly options: DocumentServiceOptions,
    fingerprint: string,
  ) {
    this.fingerprint = fingerprint;
  }

  static async open(bytes: Uint8Array, options: DocumentServiceOptions): Promise<DocumentService> {
    const pkg = await OpcPackage.open(bytes);
    const fingerprint = fingerprintBytes(bytes);
    return new DocumentService(pkg, options, fingerprint);
  }

  get rev(): Rev {
    return this.revCounter;
  }

  get package(): OpcPackage {
    return this.pkg;
  }

  get contentFingerprint(): string {
    return this.fingerprint;
  }

  readonly query = {
    summary: async (): Promise<unknown> => this.options.adapter.summary(this.pkg),
    read: async (locator: Locator): Promise<unknown> => this.options.adapter.read(this.pkg, locator),
  };

  async apply(ops: DocumentOp[]): Promise<{ rev: Rev }> {
    if (!ops.length) return { rev: this.revCounter };
    const source = ops[0]?.source ?? 'manual';
    const snapshots = new Map<string, Uint8Array>();

    // Snapshot parts that adapters might touch — adapters report dirty parts after apply.
    const beforeDigests = await this.pkg.partDigests();

    let dirtyParts: string[];
    try {
      dirtyParts = await this.options.adapter.apply(this.pkg, ops);
    } catch (error) {
      // Best-effort: if adapter mutated before throwing, caller should reopen.
      throw error;
    }

    for (const part of dirtyParts) {
      if (!snapshots.has(part) && beforeDigests.has(part)) {
        // Keep prior bytes for undo by re-reading is wrong after mutate; adapters
        // should snapshot themselves for rich undo. Here we store empty marker.
        snapshots.set(part, new Uint8Array());
      }
    }

    this.revCounter += 1;
    this.undoStack.push({ source, parts: snapshots });
    const event: ChangeEvent = { rev: this.revCounter, parts: dirtyParts, source };
    for (const listener of this.listeners) listener(event);
    return { rev: this.revCounter };
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Persist package bytes. If an external fingerprint is provided and differs,
   * refuses unless `overwriteExternal` is true (caller shows overwrite/reload UI).
   */
  async save(opts: { overwriteExternal?: boolean } = {}): Promise<{ fingerprint: string; bytes: Uint8Array }> {
    if (this.options.readExternalFingerprint) {
      const external = await this.options.readExternalFingerprint();
      if (external && external !== this.fingerprint && !opts.overwriteExternal) {
        throw new Error('EXTERNAL_MODIFIED');
      }
    }
    const bytes = await this.pkg.save();
    this.fingerprint = fingerprintBytes(bytes);
    if (this.options.writeBytes) await this.options.writeBytes(bytes);
    return { fingerprint: this.fingerprint, bytes };
  }
}

export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Minimal adapter used by core tests (no format semantics). */
export function createGenericAdapter(): FormatAdapter {
  return {
    kind: 'generic',
    async summary(pkg) {
      return { parts: pkg.listParts(), revHint: pkg.isDirty() };
    },
    async read(pkg, locator) {
      if (!locator.part) throw new Error('locator.part required');
      return new TextDecoder('utf-8').decode(await pkg.readPart(locator.part));
    },
    async apply(pkg, ops) {
      const dirty = new Set<string>();
      for (const op of ops) {
        if (op.op === 'replacePartText') {
          const part = op.target.part;
          if (!part) throw new Error('replacePartText requires target.part');
          const text = String((op.args as { text?: string } | undefined)?.text ?? '');
          pkg.writePartText(part, text);
          dirty.add(part);
        } else {
          throw new Error(`Unsupported op: ${op.op}`);
        }
      }
      return [...dirty];
    },
  };
}
