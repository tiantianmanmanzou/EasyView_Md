import * as vscode from 'vscode';
import { SETTINGS_COMMENT_RE } from './providerUtils';

type OffsetRange = { start: number; end: number };

type InlineDecorationBucket = {
  markerRanges: vscode.Range[];
  contentRanges: vscode.Range[];
};

export class NativeMarkdownDecorator implements vscode.Disposable {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const decorator = new NativeMarkdownDecorator();
    context.subscriptions.push(decorator);
    decorator.initialize();
    return decorator;
  }

  private readonly disposables: vscode.Disposable[] = [];

  private readonly headingMarkerDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0.35',
  });

  private readonly headingDecorations = [
    vscode.window.createTextEditorDecorationType({ fontWeight: '700', fontSize: '1.55em' }),
    vscode.window.createTextEditorDecorationType({ fontWeight: '700', fontSize: '1.4em' }),
    vscode.window.createTextEditorDecorationType({ fontWeight: '700', fontSize: '1.28em' }),
    vscode.window.createTextEditorDecorationType({ fontWeight: '650', fontSize: '1.18em' }),
    vscode.window.createTextEditorDecorationType({ fontWeight: '650', fontSize: '1.08em' }),
    vscode.window.createTextEditorDecorationType({ fontWeight: '650' }),
  ];

  private readonly emphasisMarkerDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0.3',
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
    opacity: '0.28',
  });

  private readonly inlineCodeDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('textCodeBlock.background'),
    borderRadius: '4px',
    fontFamily: 'monospace',
  });

  private readonly settingsCommentDecoration = vscode.window.createTextEditorDecorationType({
    opacity: '0.22',
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
        if (event.affectsConfiguration('inlineMd.nativeDecorations.enabled')) {
          this.refreshVisibleEditors();
        }
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
    this.emphasisMarkerDecoration.dispose();
    this.boldDecoration.dispose();
    this.italicDecoration.dispose();
    this.boldItalicDecoration.dispose();
    this.strikethroughDecoration.dispose();
    this.inlineCodeMarkerDecoration.dispose();
    this.inlineCodeDecoration.dispose();
    this.settingsCommentDecoration.dispose();
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
    editor.setDecorations(this.emphasisMarkerDecoration, []);
    editor.setDecorations(this.boldDecoration, []);
    editor.setDecorations(this.italicDecoration, []);
    editor.setDecorations(this.boldItalicDecoration, []);
    editor.setDecorations(this.strikethroughDecoration, []);
    editor.setDecorations(this.inlineCodeMarkerDecoration, []);
    editor.setDecorations(this.inlineCodeDecoration, []);
    editor.setDecorations(this.settingsCommentDecoration, []);
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

    for (let lineIndex = 0; lineIndex < editor.document.lineCount; lineIndex++) {
      const line = editor.document.lineAt(lineIndex);
      const headingMatch = /^(#{1,6})(\s+)(.+)$/.exec(line.text);
      if (!headingMatch) {
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

    const inlineDecorations = this.collectInlineDecorations(editor.document, text);

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
  }

  private collectInlineDecorations(document: vscode.TextDocument, text: string): Record<string, InlineDecorationBucket> {
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
