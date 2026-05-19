import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFile, spawn } from 'child_process';
import { SETTINGS_COMMENT_RE, type EditorSettings, computeMinimalDiff } from './providerUtils';
import { buildImagePathMap } from './providerImageManager';
import { downloadFile, ExportImage } from './providerExportHandler';
import { roundPdfCorners } from './pdfRoundCorners';

const inlineSuggestOutput = vscode.window.createOutputChannel('MdPre Inline Suggest');

function logInlineSuggest(message: string): void {
  inlineSuggestOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/** Open a file with the OS default application. Works with Cyrillic/Unicode paths and spaces. */
function openWithDefaultApp(fsPath: string) {
  if (process.platform === 'win32') {
    spawn('explorer', [fsPath], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    spawn('open', [fsPath], { detached: true, stdio: 'ignore' });
  } else {
    spawn('xdg-open', [fsPath], { detached: true, stdio: 'ignore' });
  }
}

function stripSnippetPlaceholders(value: string): string {
  return value
    .replace(/\$\{(\d+):([^}]+)\}/g, '$2')
    .replace(/\$\{(\d+)\|([^}]+)\|\}/g, (_m, _index, choices: string) => choices.split(',')[0] ?? '')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '');
}

function getDocumentLineOffset(document: vscode.TextDocument): number {
  const match = document.getText().match(SETTINGS_COMMENT_RE);
  if (!match?.[0]) {
    return 0;
  }
  return match[0].split(/\r?\n/).length - 1;
}

async function ensureVisibleTextEditorForInlineCompletion(
  document: vscode.TextDocument,
  webviewPanel: vscode.WebviewPanel,
  position: vscode.Position
): Promise<vscode.TextEditor | null> {
  const existingEditor = vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.toString() === document.uri.toString()
  );
  const targetEditor = existingEditor ?? null;

  if (!targetEditor) {
    logInlineSuggest(`visible-editor: no existing native editor for ${document.uri.toString()}`);
    return null;
  }

  targetEditor.selection = new vscode.Selection(position, position);
  targetEditor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
  webviewPanel.reveal(webviewPanel.viewColumn, true);

  return targetEditor;
}

async function activateTextEditorForInlineCompletion(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.TextEditor | null> {
  const existingEditor = vscode.window.visibleTextEditors.find(
    (candidate) => candidate.document.uri.toString() === document.uri.toString()
  ) ?? (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()
    ? vscode.window.activeTextEditor
    : undefined);

  if (!existingEditor) {
    logInlineSuggest(`active-editor: no existing native editor for ${document.uri.toString()}`);
    return null;
  }

  const editor = await vscode.window.showTextDocument(existingEditor.document, {
    viewColumn: existingEditor.viewColumn,
    preserveFocus: false,
    preview: false,
  });

  if (!editor) {
    return null;
  }

  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
  return editor;
}

function getInlineCompletionInsertText(item: vscode.InlineCompletionItem): string {
  const rawInsert = item.insertText as string | vscode.SnippetString | { value?: string } | undefined;
  if (typeof rawInsert === 'string') {
    return rawInsert;
  }
  if (rawInsert instanceof vscode.SnippetString) {
    return stripSnippetPlaceholders(rawInsert.value);
  }
  if (rawInsert && typeof rawInsert === 'object' && typeof rawInsert.value === 'string') {
    return stripSnippetPlaceholders(rawInsert.value);
  }
  return '';
}

function getInlineCompletionRange(
  item: vscode.InlineCompletionItem,
  position: vscode.Position
): { start: number; end: number } {
  const itemRange = item.range;
  if (
    itemRange &&
    typeof itemRange.start?.character === 'number' &&
    typeof itemRange.end?.character === 'number'
  ) {
    return { start: itemRange.start.character, end: itemRange.end.character };
  }
  return { start: position.character, end: position.character };
}

function getInlineCompletionItems(
  result: vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null | undefined
): vscode.InlineCompletionItem[] {
  if (!result) return [];
  return Array.isArray(result) ? result : result.items ?? [];
}

type TabCompletionResult = {
  insertText: string;
  replaceStartCharacter?: number;
  replaceEndCharacter?: number;
};

const INLINE_COMPLETION_COMMAND_CANDIDATES = [
  'vscode.executeInlineCompletionItemProvider',
  '_executeInlineCompletionItemProvider',
  'vscode.provideInlineCompletionItems',
  '_executeInlineCompletionsProvider',
] as const;

type InlineCompletionCommandResult =
  | vscode.InlineCompletionItem[]
  | vscode.InlineCompletionList
  | { items?: vscode.InlineCompletionItem[] | readonly vscode.InlineCompletionItem[] }
  | null
  | undefined;

type StructuredInlineCompletionCandidate = {
  insertText: string;
  filterText?: string;
  replaceStartCharacter?: number;
  replaceEndCharacter?: number;
};

const STRUCTURED_INLINE_FETCH_CHANNEL = 'structuredLogger:editor.inlineSuggest.logFetch.commandId';
const STRUCTURED_INLINE_FETCH_CONTEXT = 'structuredLogger.enabled:editor.inlineSuggest.logFetch.commandId';
const STRUCTURED_INLINE_FETCH_SETTLE_MS = 90;
const ACTIVE_EDITOR_INLINE_FETCH_SETTLE_MS = 260;
const ACTIVE_EDITOR_INLINE_TRIGGER_WAIT_MS = 120;

function createSelectedCompletionInfo(
  document: vscode.TextDocument,
  position: vscode.Position,
  wordPrefix: string
): vscode.SelectedCompletionInfo {
  const startCharacter = Math.max(0, position.character - wordPrefix.length);
  const range = new vscode.Range(position.line, startCharacter, position.line, position.character);
  const lineText = document.lineAt(position.line).text;
  return {
    range,
    text: lineText.slice(startCharacter, position.character),
  };
}

const INLINE_COMPLETION_COMMAND_ARGUMENT_VARIANTS = [
  (document: vscode.TextDocument, position: vscode.Position, wordPrefix: string) => [
    document.uri,
    position,
    {
      triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
      selectedCompletionInfo: createSelectedCompletionInfo(document, position, wordPrefix),
    },
  ],
  (document: vscode.TextDocument, position: vscode.Position, wordPrefix: string) => [
    document.uri,
    position,
    {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
      selectedCompletionInfo: createSelectedCompletionInfo(document, position, wordPrefix),
    },
  ],
  (document: vscode.TextDocument, position: vscode.Position) => [
    document.uri,
    position,
    {
      triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
    },
  ],
  (document: vscode.TextDocument, position: vscode.Position) => [
    document.uri,
    position,
    {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
    },
  ],
  (document: vscode.TextDocument, position: vscode.Position) => [
    document.uri,
    position,
  ],
] as const;

function normalizeInlineCompletionCommandResult(
  result: InlineCompletionCommandResult
): vscode.InlineCompletionItem[] {
  if (!result) return [];
  if (Array.isArray(result)) return [...result];
  if ('items' in result && Array.isArray(result.items)) return [...result.items];
  return getInlineCompletionItems(result);
}

function toTabCompletionResult(
  lineText: string,
  position: vscode.Position,
  wordPrefix: string,
  insertText: string,
  range: { start: number; end: number },
  filterText?: string
): TabCompletionResult | null {
  if (!insertText) return null;
  if (range.start > position.character || range.end < range.start) return null;

  const existing = lineText.slice(range.start, Math.min(range.end, lineText.length));
  const typedPrefix = lineText.slice(range.start, position.character);
  const matchText = filterText || insertText;
  if (
    wordPrefix &&
    typedPrefix &&
    !matchText.toLowerCase().startsWith(typedPrefix.toLowerCase()) &&
    !insertText.toLowerCase().startsWith(typedPrefix.toLowerCase())
  ) {
    return null;
  }
  if (insertText === existing) return null;

  return {
    insertText,
    replaceStartCharacter: range.start,
    replaceEndCharacter: range.end,
  };
}

function parseStructuredInlineRange(
  value: unknown
): { start: number; end: number } | undefined {
  const objectValue = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  const directStart = objectValue?.start;
  const directEnd = objectValue?.end;
  if (
    directStart && typeof directStart === 'object' &&
    typeof (directStart as { character?: unknown }).character === 'number' &&
    directEnd && typeof directEnd === 'object' &&
    typeof (directEnd as { character?: unknown }).character === 'number'
  ) {
    return {
      start: (directStart as { character: number }).character,
      end: (directEnd as { character: number }).character,
    };
  }

  if (
    objectValue &&
    typeof objectValue.startCharacter === 'number' &&
    typeof objectValue.endCharacter === 'number'
  ) {
    return {
      start: objectValue.startCharacter,
      end: objectValue.endCharacter,
    };
  }

  return undefined;
}

function extractStructuredInlineCandidates(
  value: unknown,
  documentUri: string,
  results: StructuredInlineCompletionCandidate[],
  seen: WeakSet<object>
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      extractStructuredInlineCandidates(item, documentUri, results, seen);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const uriHint =
    typeof record.modelUri === 'string' ? record.modelUri
      : typeof record.documentUri === 'string' ? record.documentUri
        : typeof record.uri === 'string' ? record.uri
          : undefined;
  if (uriHint && uriHint !== documentUri) {
    return;
  }

  const insertText =
    typeof record.insertText === 'string' ? record.insertText
      : typeof record.text === 'string' ? record.text
        : typeof record.completionText === 'string' ? record.completionText
          : typeof record.insertTextPreview === 'string' ? record.insertTextPreview
            : undefined;
  if (insertText) {
    const range = parseStructuredInlineRange(record.range);
    results.push({
      insertText,
      filterText: typeof record.filterText === 'string' ? record.filterText : undefined,
      replaceStartCharacter: range?.start,
      replaceEndCharacter: range?.end,
    });
  }

  for (const child of Object.values(record)) {
    extractStructuredInlineCandidates(child, documentUri, results, seen);
  }
}

type StructuredInlineLoggerCapture = {
  dispose: () => void;
  takeMatch: () => TabCompletionResult | null;
  waitForMatch: (timeoutMs: number) => Promise<TabCompletionResult | null>;
};

function startStructuredInlineLoggerCapture(
  document: vscode.TextDocument,
  position: vscode.Position,
  wordPrefix: string
): StructuredInlineLoggerCapture {
  const envAny = vscode.env as typeof vscode.env & {
    getDataChannel?: (channelName: string) => {
      onDidReceiveData?: (listener: (event: { data?: unknown }) => void) => vscode.Disposable;
    };
  };
  let channel:
    | {
      onDidReceiveData?: (listener: (event: { data?: unknown }) => void) => vscode.Disposable;
    }
    | undefined;
  try {
    channel = envAny.getDataChannel?.(STRUCTURED_INLINE_FETCH_CHANNEL);
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    logInlineSuggest(`structured-logger: unavailable (${errorText})`);
    return {
      dispose: () => {},
      takeMatch: () => null,
      waitForMatch: async () => null,
    };
  }
  if (!channel?.onDidReceiveData) {
    logInlineSuggest('structured-logger: data channel not available');
    return {
      dispose: () => {},
      takeMatch: () => null,
      waitForMatch: async () => null,
    };
  }

  void vscode.commands.executeCommand('setContext', STRUCTURED_INLINE_FETCH_CONTEXT, true).then(
    () => undefined,
    () => undefined
  );

  const lineText = document.lineAt(position.line).text;
  let latestMatch: TabCompletionResult | null = null;
  let disposed = false;
  const waiters = new Set<(value: TabCompletionResult | null) => void>();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    subscription.dispose();
    void vscode.commands.executeCommand('setContext', STRUCTURED_INLINE_FETCH_CONTEXT, undefined).then(
      () => undefined,
      () => undefined
    );
    for (const waiter of waiters) {
      waiter(latestMatch);
    }
    waiters.clear();
  };

  const notify = (value: TabCompletionResult | null) => {
    for (const waiter of waiters) {
      waiter(value);
    }
    waiters.clear();
  };

  const subscription = channel.onDidReceiveData((event) => {
    if (disposed || latestMatch) return;

    const candidates: StructuredInlineCompletionCandidate[] = [];
    extractStructuredInlineCandidates(event?.data, document.uri.toString(), candidates, new WeakSet<object>());

    for (const candidate of candidates) {
      const match = toTabCompletionResult(
        lineText,
        position,
        wordPrefix,
        candidate.insertText,
        {
          start: typeof candidate.replaceStartCharacter === 'number'
            ? candidate.replaceStartCharacter
            : Math.max(0, position.character - wordPrefix.length),
          end: typeof candidate.replaceEndCharacter === 'number'
            ? candidate.replaceEndCharacter
            : position.character,
        },
        candidate.filterText
      );
      if (match) {
        latestMatch = match;
        notify(match);
        return;
      }
    }
  });

  return {
    dispose,
    takeMatch: () => latestMatch,
    waitForMatch: (timeoutMs: number) => new Promise((resolve) => {
      if (latestMatch || disposed) {
        resolve(latestMatch);
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(finish);
        resolve(latestMatch);
      }, timeoutMs);
      const finish = (value: TabCompletionResult | null) => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(value);
      };
      waiters.add(finish);
    }),
  };
}

async function requestInlineCompletion(
  document: vscode.TextDocument,
  position: vscode.Position,
  wordPrefix: string,
  options?: {
    settleMs?: number;
    logLabel?: string;
  }
): Promise<TabCompletionResult | null> {
  const lineText = document.lineAt(position.line).text;
  const structuredLoggerCapture = startStructuredInlineLoggerCapture(document, position, wordPrefix);
  const logLabel = options?.logLabel ?? 'direct';

  try {
    for (const commandId of INLINE_COMPLETION_COMMAND_CANDIDATES) {
      for (const getArgs of INLINE_COMPLETION_COMMAND_ARGUMENT_VARIANTS) {
        try {
          const result = await vscode.commands.executeCommand<InlineCompletionCommandResult>(
            commandId,
            ...getArgs(document, position, wordPrefix)
          );

          for (const item of normalizeInlineCompletionCommandResult(result)) {
            const match = toTabCompletionResult(
              lineText,
              position,
              wordPrefix,
              getInlineCompletionInsertText(item),
              getInlineCompletionRange(item, position),
              item.filterText
            );
            if (match) {
              logInlineSuggest(`${logLabel}: matched via ${commandId} at ${position.line}:${position.character}`);
              return match;
            }
          }

          const structuredMatch = structuredLoggerCapture.takeMatch();
          if (structuredMatch) {
            logInlineSuggest(`${logLabel}: matched via structured logger after ${commandId} at ${position.line}:${position.character}`);
            return structuredMatch;
          }
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          if (errorText.includes('not found')) {
            continue;
          }
          console.warn(`[InLineMd] inline completion command failed: ${commandId}`, error);
          logInlineSuggest(`${logLabel}: command failed ${commandId}: ${errorText}`);
          break;
        }
      }
    }

    const fallbackMatch = await structuredLoggerCapture.waitForMatch(options?.settleMs ?? STRUCTURED_INLINE_FETCH_SETTLE_MS);
    if (fallbackMatch) {
      logInlineSuggest(`${logLabel}: matched via structured logger settle at ${position.line}:${position.character}`);
      return fallbackMatch;
    }
    logInlineSuggest(`${logLabel}: no inline completion at ${position.line}:${position.character}`);
    return null;
  } finally {
    structuredLoggerCapture.dispose();
  }
}

async function requestInlineCompletionFromActiveEditor(
  document: vscode.TextDocument,
  position: vscode.Position,
  wordPrefix: string,
  webviewPanel: vscode.WebviewPanel
): Promise<TabCompletionResult | null> {
  const activeEditor = await activateTextEditorForInlineCompletion(document, position);
  if (!activeEditor) {
    logInlineSuggest(`active-editor: failed to activate native editor for ${document.uri.toString()}`);
    return null;
  }

  logInlineSuggest(`active-editor: activated native editor for ${document.uri.toString()} at ${position.line}:${position.character}`);

  try {
    try {
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      logInlineSuggest('active-editor: executed editor.action.inlineSuggest.trigger');
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      logInlineSuggest(`active-editor: trigger command failed: ${errorText}`);
    }

    await new Promise((resolve) => setTimeout(resolve, ACTIVE_EDITOR_INLINE_TRIGGER_WAIT_MS));

    return await requestInlineCompletion(document, activeEditor.selection.active, wordPrefix, {
      settleMs: ACTIVE_EDITOR_INLINE_FETCH_SETTLE_MS,
      logLabel: 'active-editor',
    });
  } finally {
    webviewPanel.reveal(webviewPanel.viewColumn, false);
  }
}

function execGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * Context object passed to the message handler, containing all
 * references needed by message processing (webview panel, document, state, etc.).
 */
export interface MessageHandlerContext {
  webviewPanel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  getFilename: () => string;
  getLastKnownContent: () => string;
  setLastKnownContent: (content: string) => void;
  getIsUpdatingWebview: () => boolean;
  setIsUpdatingWebview: (value: boolean) => void;
  getIsUpdatingDocument: () => boolean;
  setIsUpdatingDocument: (value: boolean) => void;
  getOperationQueue: () => Promise<void>;
  setOperationQueue: (queue: Promise<void>) => void;
  refreshGitChanges?: () => Promise<void>;
  getEditorSettings: () => EditorSettings;
  updateEditorSettings: (settings: EditorSettings) => Promise<void>;
}

/**
 * Handle a single webview message. Extracted from resolveCustomTextEditor
 * to keep the main provider file focused on lifecycle management.
 */
export async function handleWebviewMessage(
  ctx: MessageHandlerContext,
  message: any
): Promise<void> {
  const { webviewPanel, document } = ctx;

  switch (message.type) {
    case 'edit': {
      if (ctx.getIsUpdatingWebview()) return;

      const editContent = message.content;
      const fullWidth = message.fullWidth ?? false;
      const tocVisible = message.tocVisible ?? false;
      const tableWrap = message.tableWrap ?? true;

      const newQueue = ctx.getOperationQueue().then(async () => {
        await ctx.updateEditorSettings({ fullWidth, tocVisible, tableWrap });
        let newContent = editContent.replace(SETTINGS_COMMENT_RE, '');

        // Convert LF (from serializer) to document's EOL to prevent
        // save-time normalization from creating a false diff
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        if (eol === '\r\n') {
          newContent = newContent.replace(/\r?\n/g, '\r\n');
        }

        if (newContent === ctx.getLastKnownContent()) return;

        ctx.setIsUpdatingDocument(true);
        try {
          const edit = new vscode.WorkspaceEdit();
          const oldContent = document.getText();
          const { start, oldEnd, newEnd } = computeMinimalDiff(oldContent, newContent);
          const startPos = document.positionAt(start);
          const endPos = document.positionAt(oldEnd);
          const replaceText = newContent.slice(start, newEnd);
          edit.replace(document.uri, new vscode.Range(startPos, endPos), replaceText);
          const success = await vscode.workspace.applyEdit(edit);
          if (success) {
            ctx.setLastKnownContent(newContent);
            await ctx.refreshGitChanges?.();
          }
        } finally {
          ctx.setIsUpdatingDocument(false);
        }
      });
      ctx.setOperationQueue(newQueue);
      break;
    }

    case 'requestTabCompletion': {
      const requestId = message.requestId;
      const requestedLine = typeof message.line === 'number' ? message.line : 0;
      const character = typeof message.character === 'number' ? message.character : 0;
      const wordPrefix = typeof message.wordPrefix === 'string' ? message.wordPrefix : '';

      logInlineSuggest(
        `request: custom-editor/webview path does not have a native inline-suggestion host; use VS Code text editor for ${document.uri.toString()}`
      );

      webviewPanel.webview.postMessage({
        type: 'tabCompletionResponse',
        requestId,
        insertText: null,
      });
      break;

    }

    case 'ready': {
      const rawContent = document.getText();
      const settings = ctx.getEditorSettings();

      // Remove settings comment and normalize to LF before sending to webview
      const contentWithoutComment = rawContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n');

      // Build image path mapping
      const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);

      webviewPanel.webview.postMessage({
        type: 'init',
        content: contentWithoutComment,
        filename: ctx.getFilename(),
        fullWidth: settings.fullWidth,
        tocVisible: settings.tocVisible,
        tableWrap: settings.tableWrap,
        imagePathMap: imagePathMap,
      });
      break;
    }

    case 'save': {
      const newQueue = ctx.getOperationQueue().then(async () => {
        // Guard save with isUpdatingDocument to prevent formatter-triggered
        // onDidChangeTextDocument from being treated as external (AI) changes
        ctx.setIsUpdatingDocument(true);
        try {
          await document.save();
          // If formatters changed content during save, sync back without AI flag
          const newContent = document.getText();
          if (newContent !== ctx.getLastKnownContent()) {
            ctx.setLastKnownContent(newContent);
            const contentWithoutComment = newContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n');
            const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);
            ctx.setIsUpdatingWebview(true);
            webviewPanel.webview.postMessage({
              type: 'documentChanged',
              content: contentWithoutComment,
              imagePathMap,
              isUndoRedo: true, // Not an external/AI change
            });
            setTimeout(() => { ctx.setIsUpdatingWebview(false); }, 100);
            await ctx.refreshGitChanges?.();
          }
        } finally {
          ctx.setIsUpdatingDocument(false);
        }
      });
      ctx.setOperationQueue(newQueue);
      break;
    }

    case 'stageFile': {
      if (document.uri.scheme !== 'file') {
        vscode.window.showInformationMessage('Only files on disk can be staged.');
        break;
      }

      const newQueue = ctx.getOperationQueue().then(async () => {
        ctx.setIsUpdatingDocument(true);
        try {
          await document.save();
        } finally {
          ctx.setIsUpdatingDocument(false);
        }

        try {
          const cwd = path.dirname(document.uri.fsPath);
          await execGit(['add', '--', document.uri.fsPath], cwd);
          await ctx.refreshGitChanges?.();
          vscode.window.showInformationMessage(`Staged: ${path.basename(document.uri.fsPath)}`);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed to stage file: ${messageText}`);
        }
      });

      ctx.setOperationQueue(newQueue);
      break;
    }

    case 'rename': {
      const newName = message.newName;
      if (!newName || typeof newName !== 'string') return;

      const oldUri = document.uri;
      const dir = path.dirname(oldUri.fsPath);
      const ext = path.extname(oldUri.fsPath);
      const newUri = vscode.Uri.file(path.join(dir, newName + ext));

      // Check if target already exists
      try {
        await vscode.workspace.fs.stat(newUri);
        vscode.window.showWarningMessage(`File "${newName}${ext}" already exists.`);
        return;
      } catch {
        // Good — file doesn't exist
      }

      const wsEdit = new vscode.WorkspaceEdit();
      wsEdit.renameFile(oldUri, newUri);
      const success = await vscode.workspace.applyEdit(wsEdit);
      if (success) {
        // Open the renamed file
        const doc = await vscode.workspace.openTextDocument(newUri);
        await vscode.window.showTextDocument(doc, { viewColumn: webviewPanel.viewColumn });
      }
      break;
    }

    case 'getImageBase64': {
      // PDF export requests: read local image file or fetch remote URL as base64 data URI
      const { requestId, originalSrc } = message;
      try {
        let base64: string | null = null;

        if (originalSrc.startsWith('http://') || originalSrc.startsWith('https://')) {
          // Remote URL: fetch via Node.js (no CORS restrictions)
          base64 = await new Promise<string | null>((resolve) => {
            const mod = originalSrc.startsWith('https://') ? https : http;
            const req = mod.get(originalSrc, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
              // Follow redirects (301, 302, 307, 308)
              if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const redirectMod = res.headers.location.startsWith('https://') ? https : http;
                redirectMod.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
                  const chunks: Buffer[] = [];
                  res2.on('data', (chunk: Buffer) => chunks.push(chunk));
                  res2.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    const ct = res2.headers['content-type'] || 'image/png';
                    const mime = ct.split(';')[0].trim();
                    resolve(`data:${mime};base64,${buf.toString('base64')}`);
                  });
                  res2.on('error', () => resolve(null));
                }).on('error', () => resolve(null));
                return;
              }
              if (res.statusCode !== 200) { resolve(null); return; }
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const ct = res.headers['content-type'] || 'image/png';
                const mime = ct.split(';')[0].trim();
                resolve(`data:${mime};base64,${buf.toString('base64')}`);
              });
              res.on('error', () => resolve(null));
            });
            req.on('error', () => resolve(null));
            req.setTimeout(15000, () => { req.destroy(); resolve(null); });
          });
        } else {
          // Local file path
          const docDir = path.dirname(document.uri.fsPath);
          let imageUri: vscode.Uri;
          if (path.isAbsolute(originalSrc)) {
            imageUri = vscode.Uri.file(originalSrc);
          } else {
            imageUri = vscode.Uri.file(path.resolve(docDir, originalSrc));
          }
          const data = await vscode.workspace.fs.readFile(imageUri);
          const buffer = Buffer.from(data);
          const ext = path.extname(originalSrc).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp',
            '.ico': 'image/x-icon',
          };
          const mime = mimeMap[ext] || 'image/png';
          base64 = `data:${mime};base64,${buffer.toString('base64')}`;
        }

        webviewPanel.webview.postMessage({
          type: 'imageBase64Response',
          requestId,
          base64,
        });
      } catch (err) {
        console.warn('[InLineMd] Failed to load image for PDF:', originalSrc, err);
        webviewPanel.webview.postMessage({
          type: 'imageBase64Response',
          requestId,
          base64: null,
        });
      }
      break;
    }

    case 'openLink': {
      const uri = message.href || message.url;
      if (uri) {
        vscode.env.openExternal(vscode.Uri.parse(uri));
      }
      break;
    }

    case 'showInfo': {
      vscode.window.showInformationMessage(message.text);
      break;
    }

    case 'pickImage': {
      const docDir = path.dirname(document.uri.fsPath);
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] },
        defaultUri: vscode.Uri.file(docDir),
      });
      if (!result || result.length === 0) break;

      const selectedFile = result[0];

      // Ensure the selected file's directory is in localResourceRoots
      const fileDir = vscode.Uri.file(path.dirname(selectedFile.fsPath));
      const currentRoots = webviewPanel.webview.options.localResourceRoots || [];
      const alreadyIncluded = currentRoots.some(r =>
        selectedFile.fsPath.startsWith(r.fsPath)
      );
      if (!alreadyIncluded) {
        webviewPanel.webview.options = {
          ...webviewPanel.webview.options,
          localResourceRoots: [...currentRoots, fileDir],
        };
      }

      const webviewUri = webviewPanel.webview.asWebviewUri(selectedFile);

      // Relative path from document to selected file (for markdown)
      let relPath = path.relative(docDir, selectedFile.fsPath).replace(/\\/g, '/');
      if (!relPath.startsWith('.') && !relPath.startsWith('/')) {
        relPath = './' + relPath;
      }

      webviewPanel.webview.postMessage({
        type: 'imageSelected',
        src: webviewUri.toString(),
        originalSrc: relPath,
        pos: message.pos,
      });
      break;
    }

    case 'dropImages': {
      const droppedPaths: string[] = message.paths;
      const dropPos: number = message.pos;
      if (!Array.isArray(droppedPaths) || droppedPaths.length === 0) break;

      const docDir = path.dirname(document.uri.fsPath);
      const images: Array<{ src: string; originalSrc: string }> = [];

      for (const filePath of droppedPaths) {
        try {
          const fileUri = vscode.Uri.file(filePath);

          // Ensure the file's directory is in localResourceRoots
          const fileDir = vscode.Uri.file(path.dirname(filePath));
          const currentRoots = webviewPanel.webview.options.localResourceRoots || [];
          const alreadyIncluded = currentRoots.some(r =>
            filePath.startsWith(r.fsPath)
          );
          if (!alreadyIncluded) {
            webviewPanel.webview.options = {
              ...webviewPanel.webview.options,
              localResourceRoots: [...currentRoots, fileDir],
            };
          }

          const webviewUri = webviewPanel.webview.asWebviewUri(fileUri);

          // Relative path from document to dropped file
          let relPath = path.relative(docDir, filePath).replace(/\\/g, '/');
          if (!relPath.startsWith('.') && !relPath.startsWith('/')) {
            relPath = './' + relPath;
          }

          images.push({ src: webviewUri.toString(), originalSrc: relPath });
        } catch (err) {
          console.error('[InLineMd] Failed to process dropped image:', filePath, err);
        }
      }

      if (images.length > 0) {
        webviewPanel.webview.postMessage({
          type: 'imagesDropped',
          images,
          pos: dropPos,
        });
      }
      break;
    }

    case 'exportPdfBase64': {
      const base64 = message.data;
      if (!base64 || typeof base64 !== 'string') break;

      const docDir = path.dirname(document.uri.fsPath);
      const defaultName = ctx.getFilename();

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(docDir, defaultName + '.pdf')),
        filters: { 'PDF': ['pdf'] },
      });

      if (!saveUri) break;

      try {
        const rawBuffer = Buffer.from(base64, 'base64');
        const rounded = await roundPdfCorners(rawBuffer);
        const buffer = Buffer.from(rounded);
        await vscode.workspace.fs.writeFile(saveUri, buffer);

        const action = await vscode.window.showInformationMessage(
          `PDF exported to ${path.basename(saveUri.fsPath)}`,
          'Open File'
        );
        if (action === 'Open File') {
          openWithDefaultApp(saveUri.fsPath);
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('EBUSY') || msg.includes('resource busy')) {
          vscode.window.showErrorMessage(
            `Cannot save PDF: the file is open in another program. Close it and try again.`
          );
        } else {
          vscode.window.showErrorMessage(`PDF export failed: ${msg}`);
        }
      }
      break;
    }

    case 'exportCsv': {
      const csvData = message.data;
      if (!csvData || typeof csvData !== 'string') break;

      const csvDocDir = path.dirname(document.uri.fsPath);
      const csvDefaultName = message.fileName || `table-${Date.now()}.csv`;

      const csvSaveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(csvDocDir, csvDefaultName)),
        filters: { 'CSV': ['csv'] },
      });

      if (!csvSaveUri) break;

      try {
        // Add UTF-8 BOM for proper encoding (Cyrillic, etc.)
        const BOM = '\uFEFF';
        await vscode.workspace.fs.writeFile(csvSaveUri, Buffer.from(BOM + csvData, 'utf-8'));

        const action = await vscode.window.showInformationMessage(
          `CSV exported to ${path.basename(csvSaveUri.fsPath)}`,
          'Open File'
        );
        if (action === 'Open File') {
          openWithDefaultApp(csvSaveUri.fsPath);
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('EBUSY') || msg.includes('resource busy')) {
          vscode.window.showErrorMessage(
            `Cannot save CSV: the file is open in another program. Close it and try again.`
          );
        } else {
          vscode.window.showErrorMessage(`CSV export failed: ${msg}`);
        }
      }
      break;
    }

    case 'exportHtml': {
      const html = message.html;
      if (!html || typeof html !== 'string') break;

      const exportImages: ExportImage[] = Array.isArray(message.images) ? message.images : [];
      const docDir = path.dirname(document.uri.fsPath);
      const defaultName = ctx.getFilename();

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(docDir, defaultName + '.html')),
        filters: { 'HTML': ['html'] },
      });

      if (!uri) break;

      try {
        if (exportImages.length === 0) {
          // No images — single HTML file (existing behavior)
          await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf-8'));
          const action = await vscode.window.showInformationMessage(
            `Exported to ${path.basename(uri.fsPath)}`,
            'Open in Browser'
          );
          if (action === 'Open in Browser') {
            openWithDefaultApp(uri.fsPath);
          }
        } else {
          // Has images — create folder structure
          const htmlFilename = path.basename(uri.fsPath);
          const folderName = path.basename(uri.fsPath, '.html');
          const parentDir = path.dirname(uri.fsPath);
          const exportDir = path.join(parentDir, folderName);
          const imagesDir = path.join(exportDir, 'images');

          await vscode.workspace.fs.createDirectory(vscode.Uri.file(exportDir));
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(imagesDir));

          // Write HTML
          const htmlPath = path.join(exportDir, htmlFilename);
          await vscode.workspace.fs.writeFile(
            vscode.Uri.file(htmlPath),
            Buffer.from(html, 'utf-8')
          );

          // Process images
          let failCount = 0;

          for (const img of exportImages) {
            const destPath = path.join(imagesDir, img.exportFilename);
            try {
              if (img.isExternal) {
                const data = await downloadFile(img.originalSrc);
                await vscode.workspace.fs.writeFile(vscode.Uri.file(destPath), data);
              } else {
                // Decode URL-encoded paths (e.g. C:%5CUsers%5C... → C:\Users\...)
                let decodedSrc = img.originalSrc;
                try { decodedSrc = decodeURIComponent(img.originalSrc); } catch { /* use as-is */ }

                const srcPath = path.isAbsolute(decodedSrc)
                  ? decodedSrc
                  : path.resolve(docDir, decodedSrc);
                await vscode.workspace.fs.copy(
                  vscode.Uri.file(srcPath),
                  vscode.Uri.file(destPath),
                  { overwrite: true }
                );
              }
            } catch (err) {
              console.error(`Failed to export image: ${img.originalSrc}`, err);
              failCount++;
            }
          }

          const failMsg = failCount > 0 ? ` (${failCount} image(s) failed)` : '';
          const action = await vscode.window.showInformationMessage(
            `Exported to ${folderName}/${htmlFilename}${failMsg}`,
            'Open in Browser'
          );
          if (action === 'Open in Browser') {
            openWithDefaultApp(htmlPath);
          }
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('EBUSY') || msg.includes('resource busy')) {
          vscode.window.showErrorMessage(
            `Cannot save HTML: the file is open in another program. Close it and try again.`
          );
        } else {
          vscode.window.showErrorMessage(`HTML export failed: ${msg}`);
        }
      }
      break;
    }
  }
}
