import {
  applyTextPatches,
  createCanonicalDocument,
  hashContent,
  type CanonicalDocument,
  type TextOffsetPatch,
} from '@easyview/editor-sync';

export interface DesktopDocumentPatchResult {
  canonicalContent: string;
  rawContent: string;
  resultHash: string;
}

/** Raw-file boundary for the shared canonical document protocol. */
export class DesktopDocumentAdapter {
  private canonical: CanonicalDocument;
  private canonicalContent: string;

  constructor(rawContent: string) {
    this.canonical = createCanonicalDocument(rawContent);
    this.canonicalContent = this.canonical.content;
  }

  get content(): string {
    return this.canonicalContent;
  }

  get rawContent(): string {
    return this.rawContentFor(this.canonicalContent);
  }

  rawContentFor(canonicalContent: string): string {
    return this.canonical.toRawContent(canonicalContent);
  }

  get lineEnding(): '\n' | '\r\n' {
    return this.canonical.eol === '\r' ? '\n' : this.canonical.eol;
  }

  apply(edits: readonly TextOffsetPatch[]): DesktopDocumentPatchResult {
    const nextContent = applyTextPatches(this.canonicalContent, edits);
    this.canonicalContent = nextContent;
    return {
      canonicalContent: nextContent,
      rawContent: this.rawContent,
      resultHash: hashContent(nextContent),
    };
  }

  replaceRaw(rawContent: string): DesktopDocumentPatchResult {
    this.canonical = createCanonicalDocument(rawContent);
    this.canonicalContent = this.canonical.content;
    return {
      canonicalContent: this.canonicalContent,
      rawContent: this.rawContent,
      resultHash: hashContent(this.canonicalContent),
    };
  }
}
