import * as vscode from 'vscode';
import {
  applyTextPatches,
  createCanonicalDocument,
  minimalTextPatch,
  type CanonicalDocument,
  type TextOffsetPatch,
} from '@easyview/editor-sync';

/** Maps canonical LF/UTF-16 edits back to the raw VS Code document. */
export class VscodeCanonicalDocumentAdapter {
  private canonical: CanonicalDocument;
  private expectedRawContent: string | null = null;

  constructor(private readonly document: vscode.TextDocument) {
    this.canonical = createCanonicalDocument(document.getText());
  }

  get content(): string {
    return this.canonical.content;
  }

  get rawContent(): string {
    return this.document.getText();
  }

  refresh(): void {
    this.canonical = createCanonicalDocument(this.document.getText());
  }

  patchesFromCurrentDocument(): TextOffsetPatch[] {
    const next = createCanonicalDocument(this.document.getText()).content;
    return minimalTextPatch(this.canonical.content, next);
  }

  matchesExpectedChange(): boolean {
    if (this.expectedRawContent === null) return false;
    const matches = this.document.getText() === this.expectedRawContent;
    if (matches) this.expectedRawContent = null;
    return matches;
  }

  async applyPatches(patches: readonly TextOffsetPatch[]): Promise<{ applied: boolean; content: string }> {
    const nextCanonical = applyTextPatches(this.canonical.content, patches);
    const rawNext = this.canonical.toRawContent(nextCanonical);
    if (rawNext === this.document.getText()) return { applied: false, content: nextCanonical };

    const edit = new vscode.WorkspaceEdit();
    const ordered = [...patches].sort((a, b) => b.from - a.from);
    for (const patch of ordered) {
      const rawRange = this.canonical.canonicalToRawRange({ from: patch.from, to: patch.to });
      const start = this.document.positionAt(rawRange.from);
      const end = this.document.positionAt(rawRange.to);
      const replacement = this.canonical.eol === '\n' ? patch.insert : patch.insert.replaceAll('\n', this.canonical.eol);
      edit.replace(this.document.uri, new vscode.Range(start, end), replacement);
    }

    this.expectedRawContent = rawNext;
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.expectedRawContent = null;
      return { applied: false, content: this.canonical.content };
    }
    this.canonical = createCanonicalDocument(rawNext);
    return { applied: true, content: nextCanonical };
  }

  async replaceCanonicalContent(content: string): Promise<{ applied: boolean; content: string }> {
    return this.applyPatches(minimalTextPatch(this.canonical.content, content));
  }
}
