/**
 * Minimal docx session over OpcPackage for inspect + body text apply.
 * Body mutations go through DocxReviewer with acceptAll so AI writes plain
 * document text (not tracked revisions). Precise run-level XML replace later.
 */

import { OpcPackage } from '@easyview/ooxml-core/opc';
import { DocxReviewer } from '@easyview/docx-agents/server';

export interface DocxParagraph {
  index: number;
  text: string;
}

export type DocxBodyOp =
  | {
      op: 'replace_text' | 'suggest_change';
      paragraphIndex: number;
      search: string;
      replaceWith: string;
    }
  | {
      op: 'add_comment';
      paragraphIndex: number;
      text: string;
      search?: string;
    };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class DocxDocument {
  private dirty = false;
  private reviewer: DocxReviewer | null = null;

  private constructor(
    readonly pkg: OpcPackage,
    private author: string,
  ) {}

  static async open(pkg: OpcPackage, author = 'EasyView AI'): Promise<DocxDocument> {
    return new DocxDocument(pkg, author);
  }

  private async ensureReviewer(): Promise<DocxReviewer> {
    if (this.reviewer) return this.reviewer;
    const bytes = await this.pkg.save();
    this.reviewer = await DocxReviewer.fromBuffer(toArrayBuffer(bytes), this.author);
    return this.reviewer;
  }

  async listParagraphs(options?: {
    fromIndex?: number;
    toIndex?: number;
  }): Promise<DocxParagraph[]> {
    const reviewer = await this.ensureReviewer();
    const fromIndex = options?.fromIndex ?? 0;
    const all = reviewer.getContent({
      includeTrackedChanges: false,
      includeCommentAnchors: false,
    });
    const end =
      options?.toIndex === undefined ? all.length - 1 : Math.min(options.toIndex, all.length - 1);
    const out: DocxParagraph[] = [];
    for (let i = Math.max(0, fromIndex); i <= end; i += 1) {
      const block = all[i] as { text?: unknown } | undefined;
      out.push({ index: i, text: typeof block?.text === 'string' ? block.text : '' });
    }
    return out;
  }

  async previewText(maxParagraphs: number): Promise<{ paragraphCount: number; preview: string }> {
    const reviewer = await this.ensureReviewer();
    const all = reviewer.getContent({
      includeTrackedChanges: false,
      includeCommentAnchors: false,
    });
    const limit = Math.max(0, Math.min(all.length, Math.floor(maxParagraphs)));
    const preview = reviewer.getContentAsText({
      fromIndex: 0,
      toIndex: Math.max(0, limit - 1),
      includeTrackedChanges: false,
      includeCommentAnchors: false,
    });
    return { paragraphCount: all.length, preview };
  }

  async applyBodyOps(ops: DocxBodyOp[]): Promise<{ changes: number; comments: number }> {
    const reviewer = await this.ensureReviewer();
    let changes = 0;
    let comments = 0;
    for (const op of ops) {
      if (op.op === 'add_comment') {
        reviewer.addComment({
          paragraphIndex: op.paragraphIndex,
          text: op.text,
          search: op.search,
        });
        comments += 1;
        continue;
      }
      if (op.search === '' && op.replaceWith === '') continue;
      if (op.search === '') {
        reviewer.proposeInsertion({
          paragraphIndex: op.paragraphIndex,
          insertText: op.replaceWith,
        });
      } else if (op.replaceWith === '') {
        reviewer.proposeDeletion({
          paragraphIndex: op.paragraphIndex,
          search: op.search,
        });
      } else {
        reviewer.replace(op.paragraphIndex, op.search, op.replaceWith);
      }
      changes += 1;
    }
    // Product behavior: AI edits land as body text, not tracked revisions.
    if (changes > 0) reviewer.acceptAll();
    this.dirty = changes > 0 || comments > 0;
    return { changes, comments };
  }

  async flush(): Promise<string[]> {
    if (!this.dirty || !this.reviewer) return [];
    const buffer = new Uint8Array(await this.reviewer.toBuffer());
    const next = await OpcPackage.open(buffer);
    const dirty: string[] = [];
    const nextNames = new Set(next.listParts());
    for (const part of this.pkg.listParts()) {
      if (!nextNames.has(part)) {
        this.pkg.deletePart(part);
        dirty.push(part);
      }
    }
    for (const part of next.listParts()) {
      this.pkg.writePart(part, await next.readPart(part));
      dirty.push(part);
    }
    this.dirty = false;
    return [...new Set(dirty)];
  }
}
