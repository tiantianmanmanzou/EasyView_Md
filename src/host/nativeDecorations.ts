import * as vscode from 'vscode';
import { SETTINGS_COMMENT_RE } from './providerUtils';
import { NATIVE_MARKDOWN_MONOSPACE_FONT_FAMILY } from './nativeEditorFont';
import { NativeMermaidRenderer } from './nativeMermaidRenderer';

type OffsetRange = { start: number; end: number };

type InlineDecorationBucket = {
  markerRanges: vscode.Range[];
  contentRanges: vscode.Range[];
};

type MermaidBlock = {
  startLine: number;
  endLine: number;
  source: string;
  numLines: number;
};

type TableBlock = {
  startLine: number;
  endLine: number;
};

const MONOSPACE_FONT_FAMILY = NATIVE_MARKDOWN_MONOSPACE_FONT_FAMILY;
const HEADING_DECORATION_STYLES = [
  { fontSize: '180%', fontWeight: '700' },
  { fontSize: '140%', fontWeight: '700' },
  { fontSize: '120%', fontWeight: '700' },
  { fontSize: '110%', fontWeight: '650' },
  { fontSize: '100%', fontWeight: '650' },
  { fontSize: '90%', fontWeight: '650' },
];

export class NativeMarkdownDecorator implements vscode.Disposable {
  public static register(context: vscode.ExtensionContext, mermaidRenderer: NativeMermaidRenderer): vscode.Disposable {
    const decorator = new NativeMarkdownDecorator(mermaidRenderer);
    context.subscriptions.push(decorator);
    decorator.initialize();
    return decorator;
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly mermaidDecorations = new Map<string, { decorationType: vscode.TextEditorDecorationType; lastUsed: number }>();
  private mermaidUpdateToken = 0;
  private mermaidUsageCounter = 0;

  private constructor(private readonly mermaidRenderer: NativeMermaidRenderer) {}

  private readonly headingMarkerDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; display: none;',
    after: {
      contentText: '',
    },
  });

  private readonly monospaceDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: `none; font-family: ${MONOSPACE_FONT_FAMILY};`,
  });

  private readonly headingDecorations = HEADING_DECORATION_STYLES.map((style) =>
    vscode.window.createTextEditorDecorationType({
      fontWeight: style.fontWeight,
      textDecoration: `none; font-family: ${MONOSPACE_FONT_FAMILY}; font-size: ${style.fontSize};`,
    })
  );

  private readonly emphasisMarkerDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; display: none;',
    after: {
      contentText: '',
    },
  });

  private readonly boldDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: '700',
  });

  private readonly italicDecoration = vscode.window.createTextEditorDecorationType({
    fontStyle: 'italic',
  });

  private readonly boldItalicDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: '700',
    fontStyle: 'italic',
  });

  private readonly strikethroughDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
  });

  private readonly inlineCodeMarkerDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none; display: none;',
    after: {
      contentText: '',
    },
  });

  private readonly inlineCodeDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
    borderRadius: '4px',
    textDecoration: 'none; font-family: monospace;',
  });

  private readonly settingsCommentDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0.22',
  });

  private readonly colonDecoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('editor.foreground'),
    opacity: '1',
  });

  private readonly listMarkerDecoration = vscode.window.createTextEditorDecorationType({
    color: 'transparent',
    textDecoration: 'none;',
  });

  private readonly tableBlockDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: `none; font-family: ${MONOSPACE_FONT_FAMILY};`,
    backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
    isWholeLine: true,
  });

  private readonly tablePipeDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0.55',
  });

  private readonly tableSeparatorDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0.45',
  });

  private initialize(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.refreshEditor(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.refreshEditor(editor);
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.refreshEditor(event.textEditor);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() === event.document.uri.toString()) {
            this.refreshEditor(editor);
          }
        }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        const editor = vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === document.uri.toString()
        );
        if (editor) {
          this.refreshEditor(editor);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.isMarkdownDocument(document)) {
          this.clearDecorationsForUri(document.uri.toString());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('inlineMd.nativeDecorations')) {
          this.refreshVisibleEditors();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.refreshVisibleEditors();
      })
    );

    this.refreshVisibleEditors();
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.headingMarkerDecoration.dispose();
    for (const decoration of this.headingDecorations) {
      decoration.dispose();
    }
    this.monospaceDecoration.dispose();
    this.emphasisMarkerDecoration.dispose();
    this.boldDecoration.dispose();
    this.italicDecoration.dispose();
    this.boldItalicDecoration.dispose();
    this.strikethroughDecoration.dispose();
    this.inlineCodeMarkerDecoration.dispose();
    this.inlineCodeDecoration.dispose();
    this.settingsCommentDecoration.dispose();
    this.colonDecoration.dispose();
    this.listMarkerDecoration.dispose();
    this.tableBlockDecoration.dispose();
    this.tablePipeDecoration.dispose();
    this.tableSeparatorDecoration.dispose();
    for (const entry of this.mermaidDecorations.values()) {
      entry.decorationType.dispose();
    }
    this.mermaidDecorations.clear();
  }

  private refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor);
    }
  }

  private clearDecorationsForUri(documentUri: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== documentUri) {
        continue;
      }
      this.clearEditor(editor);
    }
  }

  private clearEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.headingMarkerDecoration, []);
    for (const decoration of this.headingDecorations) {
      editor.setDecorations(decoration, []);
    }
    editor.setDecorations(this.monospaceDecoration, []);
    editor.setDecorations(this.emphasisMarkerDecoration, []);
    editor.setDecorations(this.boldDecoration, []);
    editor.setDecorations(this.italicDecoration, []);
    editor.setDecorations(this.boldItalicDecoration, []);
    editor.setDecorations(this.strikethroughDecoration, []);
    editor.setDecorations(this.inlineCodeMarkerDecoration, []);
    editor.setDecorations(this.inlineCodeDecoration, []);
    editor.setDecorations(this.settingsCommentDecoration, []);
    editor.setDecorations(this.colonDecoration, []);
    editor.setDecorations(this.listMarkerDecoration, []);
    editor.setDecorations(this.tableBlockDecoration, []);
    editor.setDecorations(this.tablePipeDecoration, []);
    editor.setDecorations(this.tableSeparatorDecoration, []);
    this.clearMermaidDecorations(editor);
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    if (!this.isMarkdownDocument(editor.document)) {
      this.clearEditor(editor);
      return;
    }

    const config = vscode.workspace.getConfiguration('inlineMd', editor.document.uri);
    if (!config.get<boolean>('nativeDecorations.enabled', true)) {
      this.clearEditor(editor);
      return;
    }

    const text = editor.document.getText();

    const headingMarkerRanges: vscode.Range[] = [];
    const headingTextRanges = this.headingDecorations.map(() => [] as vscode.Range[]);
    const settingsCommentRanges: vscode.Range[] = [];
    const colonRanges: vscode.Range[] = [];
    const listMarkerRanges: vscode.DecorationOptions[] = [];
    const monospaceRanges: vscode.Range[] = [];
    const tableBlockRanges: vscode.Range[] = [];
    const tablePipeRanges: vscode.Range[] = [];
    const tableSeparatorRanges: vscode.Range[] = [];
    const activeLines = this.collectActiveLines(editor);

    const mermaidBlocks = config.get<boolean>('nativeDecorations.mermaid.enabled', true)
      ? this.collectMermaidBlocks(editor.document)
      : [];
    const tableBlocks = config.get<boolean>('nativeDecorations.tables.enabled', true)
      ? this.collectTableBlocks(editor.document)
      : [];
    const mermaidLineSet = new Set<number>();
    for (const block of mermaidBlocks) {
      for (let lineIndex = block.startLine; lineIndex <= block.endLine; lineIndex++) {
        mermaidLineSet.add(lineIndex);
      }
    }

    for (const block of tableBlocks) {
      tableBlockRanges.push(new vscode.Range(block.startLine, 0, block.endLine, editor.document.lineAt(block.endLine).text.length));
    }

    for (let lineIndex = 0; lineIndex < editor.document.lineCount; lineIndex++) {
      const line = editor.document.lineAt(lineIndex);
      if (!line.isEmptyOrWhitespace) {
        monospaceRanges.push(new vscode.Range(lineIndex, 0, lineIndex, line.text.length));
      }

      for (let character = line.text.indexOf(':'); character >= 0; character = line.text.indexOf(':', character + 1)) {
        colonRanges.push(new vscode.Range(lineIndex, character, lineIndex, character + 1));
      }

      const listMarkerMatch = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line.text);
      if (listMarkerMatch && !activeLines.has(lineIndex)) {
        const startCharacter = listMarkerMatch[1].length;
        const endCharacter = startCharacter + listMarkerMatch[2].length + listMarkerMatch[3].length;
        const markerText = /^\d/.test(listMarkerMatch[2]) ? listMarkerMatch[2] : '•';
        listMarkerRanges.push({
          range: new vscode.Range(lineIndex, startCharacter, lineIndex, endCharacter),
          renderOptions: {
            before: {
              contentText: `${markerText} `,
              color: new vscode.ThemeColor('editor.foreground'),
            },
          },
        });
      }

      if (!mermaidLineSet.has(lineIndex) && /^\s*\|.*\|\s*$/.test(line.text)) {
        for (let character = line.text.indexOf('|'); character >= 0; character = line.text.indexOf('|', character + 1)) {
          tablePipeRanges.push(new vscode.Range(lineIndex, character, lineIndex, character + 1));
        }
        if (/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line.text)) {
          tableSeparatorRanges.push(new vscode.Range(lineIndex, 0, lineIndex, line.text.length));
        }
      }

      const headingMatch = /^(#{1,6})(\s+)(.+)$/.exec(line.text);
      if (!headingMatch) {
        continue;
      }

      if (activeLines.has(lineIndex)) {
        continue;
      }

      const markerLength = headingMatch[1].length + headingMatch[2].length;
      headingMarkerRanges.push(
        new vscode.Range(lineIndex, 0, lineIndex, markerLength)
      );
      headingTextRanges[headingMatch[1].length - 1].push(
        new vscode.Range(lineIndex, markerLength, lineIndex, line.text.length)
      );
    }

    const settingsCommentMatch = text.match(SETTINGS_COMMENT_RE);
    if (settingsCommentMatch?.[0]) {
      const endOffset = settingsCommentMatch[0].length;
      settingsCommentRanges.push(
        new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(endOffset))
      );
    }

    const inlineDecorations = this.collectInlineDecorations(editor.document, text, activeLines);

    editor.setDecorations(this.monospaceDecoration, monospaceRanges);
    editor.setDecorations(this.headingMarkerDecoration, headingMarkerRanges);
    this.headingDecorations.forEach((decoration, index) => {
      editor.setDecorations(decoration, headingTextRanges[index]);
    });
    editor.setDecorations(this.emphasisMarkerDecoration, [
      ...inlineDecorations.bold.markerRanges,
      ...inlineDecorations.italic.markerRanges,
      ...inlineDecorations.boldItalic.markerRanges,
      ...inlineDecorations.strikethrough.markerRanges,
    ]);
    editor.setDecorations(this.boldDecoration, inlineDecorations.bold.contentRanges);
    editor.setDecorations(this.italicDecoration, inlineDecorations.italic.contentRanges);
    editor.setDecorations(this.boldItalicDecoration, inlineDecorations.boldItalic.contentRanges);
    editor.setDecorations(this.strikethroughDecoration, inlineDecorations.strikethrough.contentRanges);
    editor.setDecorations(this.inlineCodeMarkerDecoration, inlineDecorations.inlineCode.markerRanges);
    editor.setDecorations(this.inlineCodeDecoration, inlineDecorations.inlineCode.contentRanges);
    editor.setDecorations(this.settingsCommentDecoration, settingsCommentRanges);
    editor.setDecorations(this.colonDecoration, colonRanges);
    editor.setDecorations(this.listMarkerDecoration, listMarkerRanges);
    editor.setDecorations(this.tableBlockDecoration, tableBlockRanges);
    editor.setDecorations(this.tablePipeDecoration, tablePipeRanges);
    editor.setDecorations(this.tableSeparatorDecoration, tableSeparatorRanges);

    void this.updateMermaidDecorations(editor, mermaidBlocks);
  }

  private collectMermaidBlocks(document: vscode.TextDocument): MermaidBlock[] {
    const blocks: MermaidBlock[] = [];
    let startLine: number | null = null;
    let lines: string[] = [];

    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const text = document.lineAt(lineIndex).text;
      if (startLine === null) {
        if (/^\s*```\s*(mermaid|mermaidjs)\s*$/i.test(text)) {
          startLine = lineIndex;
          lines = [];
        }
        continue;
      }

      if (/^\s*```\s*$/.test(text)) {
        blocks.push({
          startLine,
          endLine: lineIndex,
          source: lines.join('\n'),
          numLines: Math.max(1, lines.length),
        });
        startLine = null;
        lines = [];
        continue;
      }

      lines.push(text);
    }

    return blocks;
  }

  private collectTableBlocks(document: vscode.TextDocument): TableBlock[] {
    const blocks: TableBlock[] = [];
    let lineIndex = 0;

    while (lineIndex < document.lineCount) {
      const first = document.lineAt(lineIndex).text;
      const second = lineIndex + 1 < document.lineCount ? document.lineAt(lineIndex + 1).text : '';
      if (!this.isMarkdownTableRow(first) || !this.isMarkdownTableSeparator(second)) {
        lineIndex++;
        continue;
      }

      const startLine = lineIndex;
      lineIndex += 2;
      while (lineIndex < document.lineCount && this.isMarkdownTableRow(document.lineAt(lineIndex).text)) {
        lineIndex++;
      }
      blocks.push({ startLine, endLine: lineIndex - 1 });
    }

    return blocks;
  }

  private isMarkdownTableRow(text: string): boolean {
    return /^\s*\|.*\|\s*$/.test(text);
  }

  private isMarkdownTableSeparator(text: string): boolean {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text);
  }

  private async updateMermaidDecorations(editor: vscode.TextEditor, mermaidBlocks: MermaidBlock[]): Promise<void> {
    if (mermaidBlocks.length === 0) {
      this.clearMermaidDecorations(editor);
      return;
    }

    const token = ++this.mermaidUpdateToken;
    const documentVersion = editor.document.version;
    const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
      vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast
      ? 'dark'
      : 'default';
    const fontFamily = vscode.workspace.getConfiguration('editor', editor.document.uri).get<string>('fontFamily');
    const rangesByKey = new Map<string, vscode.Range[]>();
    const dataUriByKey = new Map<string, string>();

    for (const block of mermaidBlocks) {
      if (token !== this.mermaidUpdateToken || editor.document.version !== documentVersion) {
        return;
      }
      if (this.isSelectionInsideBlock(editor, block)) {
        continue;
      }

      const key = this.getMermaidDecorationKey(block, theme, fontFamily);
      let dataUri = dataUriByKey.get(key);
      if (!dataUri) {
        try {
          const svg = await this.mermaidRenderer.renderSvg(block.source, {
            theme,
            fontFamily,
            numLines: block.numLines,
          });
          dataUri = this.mermaidRenderer.svgToDataUri(svg);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          dataUri = this.mermaidRenderer.svgToDataUri(this.mermaidRenderer.createErrorSvg(message, block.numLines));
        }
        dataUriByKey.set(key, dataUri);
      }

      const endLine = editor.document.lineAt(block.endLine);
      const range = new vscode.Range(block.startLine, 0, block.endLine, endLine.text.length);
      rangesByKey.set(key, [...(rangesByKey.get(key) ?? []), range]);
    }

    if (token !== this.mermaidUpdateToken || editor.document.version !== documentVersion) {
      return;
    }

    this.applyMermaidDecorations(editor, rangesByKey, dataUriByKey);
  }

  private applyMermaidDecorations(
    editor: vscode.TextEditor,
    rangesByKey: Map<string, vscode.Range[]>,
    dataUriByKey: Map<string, string>
  ): void {
    const usedKeys = new Set<string>();
    for (const [key, ranges] of rangesByKey.entries()) {
      const dataUri = dataUriByKey.get(key);
      if (!dataUri || ranges.length === 0) {
        continue;
      }
      const decorationType = this.getOrCreateMermaidDecoration(key, dataUri);
      usedKeys.add(key);
      editor.setDecorations(decorationType, ranges);
    }
    this.disposeUnusedMermaidDecorations(editor, usedKeys);
  }

  private getOrCreateMermaidDecoration(key: string, dataUri: string): vscode.TextEditorDecorationType {
    const existing = this.mermaidDecorations.get(key);
    if (existing) {
      existing.lastUsed = ++this.mermaidUsageCounter;
      return existing.decorationType;
    }

    const decorationType = vscode.window.createTextEditorDecorationType({
      color: 'transparent',
      textDecoration: 'none; display: inline-block; width: 0;',
      before: {
        contentIconPath: vscode.Uri.parse(dataUri),
        textDecoration: 'none;',
      },
    });
    this.mermaidDecorations.set(key, {
      decorationType,
      lastUsed: ++this.mermaidUsageCounter,
    });
    this.evictMermaidDecorationCache();
    return decorationType;
  }

  private clearMermaidDecorations(editor: vscode.TextEditor): void {
    for (const entry of this.mermaidDecorations.values()) {
      editor.setDecorations(entry.decorationType, []);
    }
  }

  private disposeUnusedMermaidDecorations(editor: vscode.TextEditor, usedKeys: Set<string>): void {
    for (const [key, entry] of this.mermaidDecorations.entries()) {
      if (usedKeys.has(key)) {
        continue;
      }
      editor.setDecorations(entry.decorationType, []);
      entry.decorationType.dispose();
      this.mermaidDecorations.delete(key);
    }
  }

  private evictMermaidDecorationCache(): void {
    const maxEntries = 50;
    if (this.mermaidDecorations.size <= maxEntries) {
      return;
    }

    let oldestKey: string | undefined;
    let oldestUse = Infinity;
    for (const [key, entry] of this.mermaidDecorations.entries()) {
      if (entry.lastUsed < oldestUse) {
        oldestUse = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.mermaidDecorations.get(oldestKey)?.decorationType.dispose();
      this.mermaidDecorations.delete(oldestKey);
    }
  }

  private isSelectionInsideBlock(editor: vscode.TextEditor, block: MermaidBlock): boolean {
    return editor.selections.some((selection) =>
      selection.active.line >= block.startLine && selection.active.line <= block.endLine
    );
  }

  private getMermaidDecorationKey(block: MermaidBlock, theme: string, fontFamily?: string): string {
    return `${theme}\n${fontFamily ?? ''}\n${block.numLines}\n${block.source}`;
  }

  private collectActiveLines(editor: vscode.TextEditor): Set<number> {
    const activeLines = new Set<number>();
    for (const selection of editor.selections) {
      const startLine = Math.min(selection.start.line, selection.end.line);
      const endLine = Math.max(selection.start.line, selection.end.line);
      for (let line = startLine; line <= endLine; line++) {
        activeLines.add(line);
      }
    }
    return activeLines;
  }

  private collectInlineDecorations(
    document: vscode.TextDocument,
    text: string,
    activeLines: Set<number>
  ): Record<string, InlineDecorationBucket> {
    const buckets = {
      inlineCode: { markerRanges: [], contentRanges: [] } as InlineDecorationBucket,
      boldItalic: { markerRanges: [], contentRanges: [] } as InlineDecorationBucket,
      bold: { markerRanges: [], contentRanges: [] } as InlineDecorationBucket,
      italic: { markerRanges: [], contentRanges: [] } as InlineDecorationBucket,
      strikethrough: { markerRanges: [], contentRanges: [] } as InlineDecorationBucket,
    };

    const blockedRanges: OffsetRange[] = [];

    const registerDelimitedMatches = (
      regex: RegExp,
      markerLengthResolver: (matchText: string, groups: string[]) => number,
      bucket: InlineDecorationBucket
    ): void => {
      for (const match of text.matchAll(regex)) {
        const matchText = match[0];
        const matchIndex = match.index;
        if (matchIndex === undefined) {
          continue;
        }
        const matchEnd = matchIndex + matchText.length;
        if (this.overlapsBlockedRange(matchIndex, matchEnd, blockedRanges)) {
          continue;
        }
        const startLine = document.positionAt(matchIndex).line;
        const endLine = document.positionAt(matchEnd).line;
        let intersectsActiveLine = false;
        for (let line = startLine; line <= endLine; line++) {
          if (activeLines.has(line)) {
            intersectsActiveLine = true;
            break;
          }
        }
        if (intersectsActiveLine) {
          continue;
        }

        const markerLength = markerLengthResolver(matchText, match.slice(1));
        const contentStart = matchIndex + markerLength;
        const contentEnd = matchEnd - markerLength;
        if (contentEnd <= contentStart) {
          continue;
        }

        bucket.markerRanges.push(
          new vscode.Range(document.positionAt(matchIndex), document.positionAt(contentStart)),
          new vscode.Range(document.positionAt(contentEnd), document.positionAt(matchEnd))
        );
        bucket.contentRanges.push(
          new vscode.Range(document.positionAt(contentStart), document.positionAt(contentEnd))
        );
        blockedRanges.push({ start: matchIndex, end: matchEnd });
      }
    };

    registerDelimitedMatches(/(`+)([^`\n]+?)\1/g, (_matchText, groups) => groups[0]?.length ?? 1, buckets.inlineCode);
    registerDelimitedMatches(/(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1/g, (_matchText, groups) => groups[0]?.length ?? 3, buckets.boldItalic);
    registerDelimitedMatches(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_matchText, groups) => groups[0]?.length ?? 2, buckets.bold);
    registerDelimitedMatches(/(?<!\*)\*(?!\*)(?=\S)(.+?)(?<=\S)(?<!\*)\*(?!\*)/g, () => 1, buckets.italic);
    registerDelimitedMatches(/(?<!_)_(?!_)(?=\S)(.+?)(?<=\S)(?<!_)_(?!_)/g, () => 1, buckets.italic);
    registerDelimitedMatches(/(~~)(?=\S)(.+?)(?<=\S)\1/g, () => 2, buckets.strikethrough);

    return buckets;
  }

  private overlapsBlockedRange(start: number, end: number, blockedRanges: OffsetRange[]): boolean {
    return blockedRanges.some((blockedRange) => start < blockedRange.end && end > blockedRange.start);
  }

  private isMarkdownDocument(document: vscode.TextDocument): boolean {
    return ['markdown', 'mdx'].includes(document.languageId)
      || /\.(md|markdown|mdx)$/i.test(document.uri.fsPath);
  }
}
