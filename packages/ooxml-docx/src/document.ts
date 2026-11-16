/**
 * Docx session over OpcPackage: inspect paragraphs + body text apply.
 * Text replacements use precise run-level XML edits on word/document.xml
 * (untouched parts stay intact). Comments still go through DocxReviewer.
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

const element = (tag: string) =>
  `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;

const decode = (text: string) =>
  text.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) =>
    hex || dec
      ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))
      : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as string] ?? ''),
  );

const encode = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function paragraphMatches(documentXml: string): RegExpMatchArray[] {
  return [...documentXml.matchAll(new RegExp(element('w:p'), 'g'))];
}

function paragraphText(paragraphXml: string): string {
  return [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decode(match[1]))
    .join('');
}

/**
 * Rewrite joined run text inside a paragraph. Prefer keeping the first run's
 * formatting; clear subsequent <w:t> nodes when the replacement is shorter/longer.
 */
function rewriteParagraphJoinedText(paragraphXml: string, nextText: string): string {
  const runs = [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
  if (!runs.length) {
    // Empty paragraph: inject a minimal run before </w:p>.
    if (!nextText) return paragraphXml;
    return paragraphXml.replace(
      /<\/w:p>/,
      `<w:r><w:t xml:space="preserve">${encode(nextText)}</w:t></w:r></w:p>`,
    );
  }
  let replaced = false;
  return paragraphXml.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (full) => {
    if (!replaced) {
      replaced = true;
      const open = full.slice(0, full.indexOf('>') + 1);
      // Preserve xml:space when replacement has leading/trailing spaces.
      const needsSpace = /^\s|\s$/.test(nextText);
      const openTag = needsSpace && !/\bxml:space=/.test(open)
        ? open.replace(/^<w:t/, '<w:t xml:space="preserve"')
        : open;
      return `${openTag}${encode(nextText)}</w:t>`;
    }
    return full.replace(/>[\s\S]*<\/w:t>/, '></w:t>');
  });
}

function applyTextOpToParagraph(
  paragraphXml: string,
  op: Extract<DocxBodyOp, { op: 'replace_text' | 'suggest_change' }>,
): string {
  const before = paragraphText(paragraphXml);
  let after = before;
  if (op.search === '') {
    after = `${before}${op.replaceWith}`;
  } else if (op.replaceWith === '') {
    if (!before.includes(op.search)) {
      throw new Error(`Text not found in paragraph ${op.paragraphIndex}: ${op.search}`);
    }
    after = before.replace(op.search, '');
  } else {
    if (!before.includes(op.search)) {
      throw new Error(`Text not found in paragraph ${op.paragraphIndex}: ${op.search}`);
    }
    after = before.replace(op.search, op.replaceWith);
  }
  if (after === before) return paragraphXml;
  return rewriteParagraphJoinedText(paragraphXml, after);
}

export class DocxDocument {
  private dirtyParts = new Set<string>();
  private reviewer: DocxReviewer | null = null;
  private documentXml: string | null = null;

  private constructor(
    readonly pkg: OpcPackage,
    private author: string,
  ) {}

  static async open(pkg: OpcPackage, author = 'EasyView AI'): Promise<DocxDocument> {
    return new DocxDocument(pkg, author);
  }

  private async loadDocumentXml(): Promise<string> {
    if (this.documentXml != null) return this.documentXml;
    this.documentXml = await this.pkg.readPartText('word/document.xml');
    return this.documentXml;
  }

  private async ensureReviewer(): Promise<DocxReviewer> {
    if (this.reviewer) return this.reviewer;
    // Flush precise XML edits into the package before opening the reviewer.
    if (this.documentXml != null && this.dirtyParts.has('word/document.xml')) {
      this.pkg.writePartText('word/document.xml', this.documentXml);
    }
    const bytes = await this.pkg.save();
    this.reviewer = await DocxReviewer.fromBuffer(toArrayBuffer(bytes), this.author);
    return this.reviewer;
  }

  async listParagraphs(options?: {
    fromIndex?: number;
    toIndex?: number;
  }): Promise<DocxParagraph[]> {
    const xml = await this.loadDocumentXml();
    const matches = paragraphMatches(xml);
    const fromIndex = options?.fromIndex ?? 0;
    const end =
      options?.toIndex === undefined ? matches.length - 1 : Math.min(options.toIndex, matches.length - 1);
    const out: DocxParagraph[] = [];
    for (let i = Math.max(0, fromIndex); i <= end; i += 1) {
      out.push({ index: i, text: paragraphText(matches[i][0]) });
    }
    return out;
  }

  async previewText(maxParagraphs: number): Promise<{ paragraphCount: number; preview: string }> {
    const xml = await this.loadDocumentXml();
    const matches = paragraphMatches(xml);
    const limit = Math.max(0, Math.min(matches.length, Math.floor(maxParagraphs)));
    const lines: string[] = [];
    for (let i = 0; i < limit; i += 1) {
      lines.push(`[${i}] ${paragraphText(matches[i][0])}`);
    }
    return { paragraphCount: matches.length, preview: lines.join('\n') };
  }

  async applyBodyOps(ops: DocxBodyOp[]): Promise<{ changes: number; comments: number }> {
    const textOps = ops.filter(
      (op): op is Extract<DocxBodyOp, { op: 'replace_text' | 'suggest_change' }> =>
        op.op === 'replace_text' || op.op === 'suggest_change',
    );
    const commentOps = ops.filter(
      (op): op is Extract<DocxBodyOp, { op: 'add_comment' }> => op.op === 'add_comment',
    );

    let changes = 0;
    if (textOps.length > 0) {
      changes = await this.applyPreciseTextOps(textOps);
    }

    let comments = 0;
    if (commentOps.length > 0) {
      const reviewer = await this.ensureReviewer();
      for (const op of commentOps) {
        reviewer.addComment({
          paragraphIndex: op.paragraphIndex,
          text: op.text,
          search: op.search,
        });
        comments += 1;
      }
      this.dirtyParts.add('__reviewer__');
    }

    return { changes, comments };
  }

  private async applyPreciseTextOps(
    ops: Array<Extract<DocxBodyOp, { op: 'replace_text' | 'suggest_change' }>>,
  ): Promise<number> {
    const xml = await this.loadDocumentXml();
    const matches = paragraphMatches(xml);
    if (!matches.length) throw new Error('Document has no paragraphs');
    const updated = matches.map((match) => match[0]);
    let changes = 0;
    for (const op of ops) {
      if (op.search === '' && op.replaceWith === '') continue;
      const current = updated[op.paragraphIndex];
      if (!current) throw new Error(`Unknown paragraph index ${op.paragraphIndex}`);
      const next = applyTextOpToParagraph(current, op);
      if (next === current) continue;
      updated[op.paragraphIndex] = next;
      changes += 1;
    }
    if (changes === 0) return 0;

    let out = '';
    let cursor = 0;
    for (let i = 0; i < matches.length; i += 1) {
      const match = matches[i];
      const index = match.index ?? 0;
      out += xml.slice(cursor, index);
      out += updated[i];
      cursor = index + match[0].length;
    }
    out += xml.slice(cursor);
    this.documentXml = out;
    this.dirtyParts.add('word/document.xml');
    // Invalidate reviewer cache; package bytes for comments must include these edits.
    this.reviewer = null;
    return changes;
  }

  async flush(): Promise<string[]> {
    if (this.dirtyParts.size === 0) return [];

    if (this.documentXml != null && this.dirtyParts.has('word/document.xml')) {
      this.pkg.writePartText('word/document.xml', this.documentXml);
    }

    if (this.dirtyParts.has('__reviewer__')) {
      const reviewer = await this.ensureReviewer();
      const buffer = new Uint8Array(await reviewer.toBuffer());
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
      this.documentXml = null;
      this.reviewer = null;
      this.dirtyParts.clear();
      return [...new Set(dirty)];
    }

    const dirty = [...this.dirtyParts];
    this.dirtyParts.clear();
    return dirty;
  }
}
