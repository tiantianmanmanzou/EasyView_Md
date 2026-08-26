import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFile } from 'child_process';
import { Packer } from 'docx';
import { SETTINGS_COMMENT_RE, type EditorSettings, computeMinimalDiff, repairSerializedMarkdownContent } from './providerUtils';
import { buildImagePathMap } from './providerImageManager';
import { roundPdfCorners } from './pdfRoundCorners';
import { ensureNativeMarkdownEditorFont } from './nativeEditorFont';
import { suppressConflictingMarkdownInlineDecorations } from './conflictingExtensions';
import { consumePendingCursorForUri } from './openCursorContext';
import { logOpenWithDebug } from './openWithDebug';
import { disposeTerminalForPanel, openTerminalForPanel, resizeTerminalForPanel, writeTerminalInput } from './terminalSessionManager';
import type { WebviewToHostMessage } from '../shared/protocol';
import { handleWebviewExportMessage } from './providerWebviewExportHandlers';
import { openWithDefaultApp } from './openWithDefaultApp';
import { markdownToDocx } from './docxExport';

const inlineSuggestOutput = vscode.window.createOutputChannel('MdPre Inline Suggest');

function logInlineSuggest(message: string): void {
  inlineSuggestOutput.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function sanitizeImageBaseName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'image';
}

function allocatePastedImageTarget(document: vscode.TextDocument, extension: string): { directory: vscode.Uri; file: vscode.Uri } {
  const docDir = path.dirname(document.uri.fsPath);
  const stem = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
  const safeStem = sanitizeImageBaseName(stem);
  const directory = vscode.Uri.file(path.join(docDir, `${safeStem}.assets`));
  const filename = `${safeStem}-${Date.now()}${extension}`;
  const file = vscode.Uri.joinPath(directory, filename);
  return { directory, file };
}

function mimeTypeToImageExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.png';
  }
}

const EASYVIEW_MANAGED_KEYBINDING_START = '// EasyView_Md managed shortcuts start';
const EASYVIEW_MANAGED_KEYBINDING_END = '// EasyView_Md managed shortcuts end';
const OPEN_EDITOR_WHEN = 'editorTextFocus && (resourceLangId == markdown || resourceLangId == mdx)';
const DEFAULT_OPEN_EDITOR_KEY = 'alt+e';

function getDefaultTerminalFontFamily(): string {
  if (process.platform === 'darwin') {
    return 'Menlo, Monaco, "Courier New", monospace';
  }
  if (process.platform === 'win32') {
    return 'Cascadia Mono, Consolas, "Courier New", monospace';
  }
  return '"DejaVu Sans Mono", "Liberation Mono", monospace';
}

function readTerminalAppearance(): { fontFamily: string; fontSize: number; lineHeight: number; fontWeight: string; fontWeightBold: string; letterSpacing: number } {
  const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
  const terminalFontFamily = terminalConfig.get<string>('fontFamily', '').trim();
  return {
    fontFamily: terminalFontFamily || getDefaultTerminalFontFamily(),
    fontSize: terminalConfig.get<number>('fontSize', 13),
    lineHeight: terminalConfig.get<number>('lineHeight', 1),
    fontWeight: terminalConfig.get<string>('fontWeight', 'normal'),
    fontWeightBold: terminalConfig.get<string>('fontWeightBold', 'bold'),
    letterSpacing: terminalConfig.get<number>('letterSpacing', 0),
  };
}

function getUserKeybindingsFilePath(): string {
  const home = os.homedir();
  const appName = vscode.env.appName;

  let productFolder = 'Code';
  if (/Insiders/i.test(appName)) productFolder = 'Code - Insiders';
  else if (/VSCodium/i.test(appName)) productFolder = 'VSCodium';
  else if (/Code - OSS/i.test(appName)) productFolder = 'Code - OSS';

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', productFolder, 'User', 'keybindings.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, productFolder, 'User', 'keybindings.json');
  }
  return path.join(home, '.config', productFolder, 'User', 'keybindings.json');
}

function normalizeShortcutForKeybinding(shortcut: string): string {
  const parts = shortcut.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const mods = new Set<string>();
  let key = '';
  for (const partRaw of parts) {
    const part = partRaw.toLowerCase();
    if (part === 'ctrl' || part === 'control') { mods.add('ctrl'); continue; }
    if (part === 'meta' || part === 'cmd' || part === 'command') { mods.add('cmd'); continue; }
    if (part === 'alt' || part === 'option') { mods.add('alt'); continue; }
    if (part === 'shift') { mods.add('shift'); continue; }
    key = partRaw;
  }
  const normalizeKey = (value: string): string => {
    const v = value.trim();
    if (!v) return '';
    const lower = v.toLowerCase();
    const map: Record<string, string> = {
      arrowup: 'up',
      up: 'up',
      arrowdown: 'down',
      down: 'down',
      arrowleft: 'left',
      left: 'left',
      arrowright: 'right',
      right: 'right',
      space: 'space',
      escape: 'escape',
      esc: 'escape',
      enter: 'enter',
      tab: 'tab',
      backspace: 'backspace',
      delete: 'delete',
    };
    if (map[lower]) return map[lower];
    return lower;
  };
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return '';
  const orderedMods = ['ctrl', 'cmd', 'alt', 'shift'].filter((mod) => mods.has(mod));
  return [...orderedMods, normalizedKey].join('+');
}

async function syncOpenEditorShortcutToUserKeybindings(shortcut: string): Promise<void> {
  const normalized = normalizeShortcutForKeybinding(shortcut);
  if (!normalized) return;

  const keybindingsPath = getUserKeybindingsFilePath();
  const keybindingsUri = vscode.Uri.file(keybindingsPath);
  const keybindingsDir = vscode.Uri.file(path.dirname(keybindingsPath));
  await vscode.workspace.fs.createDirectory(keybindingsDir);

  let text = '[]';
  try {
    const bytes = await vscode.workspace.fs.readFile(keybindingsUri);
    text = Buffer.from(bytes).toString('utf8');
    if (!text.trim()) text = '[]';
  } catch {
    text = '[]';
  }

  const escapedStart = EASYVIEW_MANAGED_KEYBINDING_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = EASYVIEW_MANAGED_KEYBINDING_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const managedBlockRe = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  let stripped = text.replace(managedBlockRe, '').trimEnd();
  if (!stripped.trim()) stripped = '[]';
  if (!stripped.includes('[')) stripped = '[]';

  const managedLines = [
    EASYVIEW_MANAGED_KEYBINDING_START,
    `  { "key": "${DEFAULT_OPEN_EDITOR_KEY}", "command": "-inlineMd.openEditor", "when": "${OPEN_EDITOR_WHEN}" },`,
    `  { "key": "${normalized}", "command": "inlineMd.openEditor", "when": "${OPEN_EDITOR_WHEN}" }`,
    EASYVIEW_MANAGED_KEYBINDING_END,
  ];
  const block = managedLines.join('\n');

  const closeIndex = stripped.lastIndexOf(']');
  if (closeIndex < 0) {
    stripped = `[\n${block}\n]\n`;
  } else {
    const before = stripped.slice(0, closeIndex).trimEnd();
    const needsComma = before.length > 1 && before !== '[' && !before.endsWith(',');
    const appended = `${before}${needsComma ? ',' : ''}\n${block}\n]`;
    stripped = `${appended}\n`;
  }

  await vscode.workspace.fs.writeFile(keybindingsUri, Buffer.from(stripped, 'utf8'));
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

function execGitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const stderrText = typeof stderr === 'string' ? stderr.trim() : '';
        reject(new Error(stderrText || error.message));
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    });
  });
}

function sanitizeCommitMessage(value: string): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z-]*\n?|\n?```/g, ''))
    .split(/\r?\n/)
    .map((line) => line.replace(/^["'`]+|["'`]+$/g, '').trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim()
    .replace(/^commit message:\s*/i, '')
    .trim();
  return cleaned.split(/\r?\n/).slice(0, 8).join('\n').trim();
}

function hasCjkText(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function commitMessageSubject(fileName: string, status: string, diff: string): string {
  const baseName = path.basename(fileName);
  const lower = baseName.toLowerCase();
  const scope = /\.(md|markdown|mdx)$/i.test(baseName) || lower === 'readme' ? 'docs' : 'chore';
  const additions = (diff.match(/^\+/gm) ?? []).length;
  const deletions = (diff.match(/^-/gm) ?? []).length;

  if (status.startsWith('??') || (/^A/.test(status))) {
    return `${scope}: add ${baseName}`;
  }
  if (status.includes('D')) {
    return `${scope}: remove ${baseName}`;
  }
  if (additions > 0 && deletions === 0) {
    return `${scope}: expand ${baseName}`;
  }
  return `${scope}: update ${baseName}`;
}

function commitMessageChineseBody(fileName: string, status: string, diff: string): string[] {
  const baseName = path.basename(fileName);
  const additions = (diff.match(/^\+/gm) ?? []).length;
  const deletions = (diff.match(/^-/gm) ?? []).length;

  if (status.startsWith('??') || (/^A/.test(status))) {
    return [
      '主要改动:',
      `- 新增 ${baseName}，将当前文件纳入版本管理。`,
      '- 补充当前文件的初始内容，便于后续维护。',
    ];
  }
  if (status.includes('D')) {
    return [
      '主要改动:',
      `- 删除 ${baseName}，清理不再使用的文件内容。`,
      '- 保持提交范围仅限当前文件。',
    ];
  }
  if (additions > 0 && deletions > 0) {
    return [
      '主要改动:',
      `- 更新 ${baseName} 的内容，调整已有说明或实现。`,
      `- 本次变更包含 ${additions} 行新增和 ${deletions} 行删除。`,
    ];
  }
  if (additions > 0) {
    return [
      '主要改动:',
      `- 扩充 ${baseName} 的内容，补充新的说明或实现。`,
      `- 本次变更新增约 ${additions} 行内容。`,
    ];
  }
  return [
    '主要改动:',
    `- 更新 ${baseName} 的内容，保持文件与当前需求一致。`,
    '- 保持提交范围仅限当前文件。',
  ];
}

function ensureBilingualCommitMessageFormat(message: string, fileName: string, status: string, diff: string): string {
  const sanitized = sanitizeCommitMessage(message);
  const lines = sanitized.split(/\r?\n/);
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim());
  const candidateSubject = firstNonEmptyIndex >= 0 ? lines[firstNonEmptyIndex].trim() : '';
  const subject = candidateSubject && !hasCjkText(candidateSubject)
    ? candidateSubject
    : commitMessageSubject(fileName, status, diff);
  const body = firstNonEmptyIndex >= 0
    ? lines.slice(firstNonEmptyIndex + 1).map((line) => line.trimEnd()).filter((line, index, arr) => (
      line.trim() || (index > 0 && index < arr.length - 1)
    ))
    : [];
  const hasChineseBody = body.some((line) => hasCjkText(line));
  const finalBody = hasChineseBody ? body : commitMessageChineseBody(fileName, status, diff);
  return [subject, '', ...finalBody].join('\n').trim();
}

async function resolveGitFileContext(document: vscode.TextDocument): Promise<{
  root: string;
  relativePath: string;
  status: string;
  diff: string;
}> {
  const cwd = path.dirname(document.uri.fsPath);
  const root = (await execGitOutput(['rev-parse', '--show-toplevel'], cwd)).trim();
  const relativePath = path.relative(root, document.uri.fsPath).replace(/\\/g, '/');
  const status = (await execGitOutput(['status', '--porcelain=v1', '--', relativePath], root)).trim();
  let diff = '';
  try {
    diff = await execGitOutput(['diff', '--', relativePath], root);
  } catch {
    diff = '';
  }
  if (!diff.trim()) {
    try {
      diff = await execGitOutput(['diff', '--cached', '--', relativePath], root);
    } catch {
      diff = '';
    }
  }
  if (!diff.trim() && status.startsWith('??')) {
    const content = document.getText();
    diff = [
      `diff --git a/${relativePath} b/${relativePath}`,
      'new file mode 100644',
      `--- /dev/null`,
      `+++ b/${relativePath}`,
      '@@',
      ...content.split(/\r?\n/).slice(0, 400).map((line) => `+${line}`),
    ].join('\n');
  }
  return { root, relativePath, status, diff };
}

async function resolveGitPushState(root: string): Promise<{
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}> {
  try {
    await execGitOutput(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root);
  } catch {
    return { hasUpstream: false, ahead: 0, behind: 0 };
  }

  try {
    const raw = (await execGitOutput(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], root)).trim();
    const [behindText = '0', aheadText = '0'] = raw.split(/\s+/);
    const behind = Number.parseInt(behindText, 10);
    const ahead = Number.parseInt(aheadText, 10);
    return {
      hasUpstream: true,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  } catch {
    return { hasUpstream: true, ahead: 0, behind: 0 };
  }
}

function truncateForPrompt(value: string, maxChars = 12000): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[Diff truncated for commit message generation]`;
}

async function generateCommitMessageWithVsCodeLm(fileName: string, status: string, diff: string): Promise<string | null> {
  const lm = (vscode as any).lm;
  const ChatMessage = (vscode as any).LanguageModelChatMessage;
  if (!lm?.selectChatModels || !ChatMessage?.User) return null;

  const models = [
    ...(await lm.selectChatModels({ vendor: 'copilot' }).catch(() => [])),
    ...(await lm.selectChatModels().catch(() => [])),
  ];
  const model = models[0];
  if (!model?.sendRequest) return null;

  const prompt = [
    'Generate a Git commit message for the current file only.',
    'Format requirements:',
    '1. The first line must be English only and use Conventional Commit style, for example "fix(ui): update backend server information display".',
    '2. Add one blank line after the first line.',
    '3. The remaining lines must be Chinese and summarize the main changes.',
    '4. Prefer this body style:',
    '主要改动:',
    '- 中文改动说明一。',
    '- 中文改动说明二。',
    'Return only the commit message text. Do not include Markdown fences or explanations.',
    '',
    `File: ${fileName}`,
    `Git status: ${status || 'modified'}`,
    '',
    'Diff:',
    truncateForPrompt(diff),
  ].join('\n');

  const response = await model.sendRequest([ChatMessage.User(prompt)]);
  let text = '';
  for await (const fragment of response.text) {
    text += fragment;
  }
  return ensureBilingualCommitMessageFormat(text, fileName, status, diff) || null;
}

async function getGitApi(): Promise<any | null> {
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) return null;
  const gitExtension = extension.isActive ? extension.exports : (await extension.activate());
  return gitExtension?.getAPI?.(1) ?? null;
}

async function generateCommitMessageWithScmCommand(document: vscode.TextDocument): Promise<string | null> {
  const api = await getGitApi();
  const repo = api?.getRepository?.(document.uri);
  if (!repo?.rootUri) return null;

  const previous = typeof repo.inputBox?.value === 'string' ? repo.inputBox.value.trim() : '';
  await vscode.commands.executeCommand('github.copilot.git.generateCommitMessage', repo.rootUri);

  const start = Date.now();
  while (Date.now() - start < 30000) {
    const current = typeof repo.inputBox?.value === 'string' ? repo.inputBox.value.trim() : '';
    if (current && current !== previous) {
      return ensureBilingualCommitMessageFormat(current, path.basename(document.uri.fsPath), '', '') || null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const current = typeof repo.inputBox?.value === 'string' ? repo.inputBox.value.trim() : '';
  return current ? ensureBilingualCommitMessageFormat(current, path.basename(document.uri.fsPath), '', '') || null : null;
}

function heuristicCommitMessage(fileName: string, status: string, diff: string): string {
  return [
    commitMessageSubject(fileName, status, diff),
    '',
    ...commitMessageChineseBody(fileName, status, diff),
  ].join('\n');
}

async function generateCommitMessageForCurrentFile(document: vscode.TextDocument): Promise<{ message: string; source: string }> {
  const context = await resolveGitFileContext(document);
  if (!context.status) {
    throw new Error('Current file has no Git changes to commit.');
  }

  const fileName = path.basename(document.uri.fsPath);
  try {
    const aiMessage = await generateCommitMessageWithVsCodeLm(fileName, context.status, context.diff);
    if (aiMessage) {
      return { message: aiMessage, source: 'Generated by VS Code AI' };
    }
  } catch (error) {
    console.warn('[InLineMd] VS Code language model commit message generation failed:', toErrorMessage(error));
  }

  try {
    const scmMessage = await generateCommitMessageWithScmCommand(document);
    if (scmMessage) {
      return { message: scmMessage, source: 'Generated by VS Code SCM AI' };
    }
  } catch (error) {
    console.warn('[InLineMd] VS Code SCM commit message generation failed:', toErrorMessage(error));
  }

  return {
    message: heuristicCommitMessage(fileName, context.status, context.diff),
    source: 'Generated from current file diff',
  };
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
  getTableFirstRowStickyDefault: () => boolean;
  setTableFirstRowStickyDefault: (sticky: boolean) => Promise<void>;
}

async function syncWebviewContentToDocument(
  ctx: MessageHandlerContext,
  editContent: string,
  settings: EditorSettings
): Promise<void> {
  const document = ctx.document;

  await ctx.updateEditorSettings(settings);
  let newContent = repairSerializedMarkdownContent(editContent.replace(SETTINGS_COMMENT_RE, ''));

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
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enqueueOperation(
  ctx: MessageHandlerContext,
  operationName: string,
  operation: () => Promise<void>,
  onError?: (messageText: string) => void
): void {
  const queue = ctx.getOperationQueue()
    .catch((error) => {
      console.warn(`[InLineMd] Previous queued operation failed before ${operationName}: ${toErrorMessage(error)}`);
    })
    .then(operation)
    .catch((error) => {
      const messageText = toErrorMessage(error);
      console.error(`[InLineMd] ${operationName} failed:`, error);
      onError?.(messageText);
    });
  ctx.setOperationQueue(queue);
}

/**
 * Handle a single webview message. Extracted from resolveCustomTextEditor
 * to keep the main provider file focused on lifecycle management.
 */
export async function handleWebviewMessage(
  ctx: MessageHandlerContext,
  message: WebviewToHostMessage
): Promise<void> {
  const { webviewPanel, document } = ctx;

  if (message.type === 'exportXlsx' || message.type === 'exportHtml') {
    await handleWebviewExportMessage(ctx, message);
    return;
  }

  switch (message.type) {
    case 'edit': {
      if (ctx.getIsUpdatingWebview()) return;

      const editContent = message.content;
      logOpenWithDebug('providerMessage.editReceived', {
        path: document.uri.fsPath,
        editLength: typeof editContent === 'string' ? editContent.length : -1,
        lastKnownLength: ctx.getLastKnownContent().length,
      });
      const fullWidth = message.fullWidth ?? true;
      const tocVisible = message.tocVisible ?? true;
      const tableWrap = message.tableWrap ?? false;

      enqueueOperation(ctx, 'webview edit sync', async () => {
        await syncWebviewContentToDocument(ctx, editContent, { fullWidth, tocVisible, tableWrap });
      });
      break;
    }

    case 'openNativeSourceMode': {
      const editContent = typeof message.content === 'string'
        ? message.content
        : ctx.getLastKnownContent();
      const fullWidth = message.fullWidth ?? true;
      const tocVisible = message.tocVisible ?? true;
      const tableWrap = message.tableWrap ?? false;
      const requestedLine = typeof message.line === 'number' ? message.line : 0;
      const requestedCharacter = typeof message.character === 'number' ? message.character : 0;

      enqueueOperation(
        ctx,
        'open native source mode',
        async () => {
        await syncWebviewContentToDocument(ctx, editContent, { fullWidth, tocVisible, tableWrap });
        await ensureNativeMarkdownEditorFont(document);

        const targetLine = Math.min(Math.max(0, requestedLine), Math.max(0, document.lineCount - 1));
        const targetCharacter = Math.min(
          Math.max(0, requestedCharacter),
          document.lineAt(targetLine).text.length
        );
        const position = new vscode.Position(targetLine, targetCharacter);
        const editor = await vscode.window.showTextDocument(document, {
          viewColumn: webviewPanel.viewColumn,
          preserveFocus: false,
          preview: false,
        });
        await suppressConflictingMarkdownInlineDecorations(editor);

        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

        },
        (messageText) => {
          vscode.window.showErrorMessage(`Failed to open native source mode: ${messageText}`);
        }
      );
      break;
    }

    case 'requestTabCompletion': {
      const requestId = message.requestId;
      logInlineSuggest(`request: custom-editor completion is unavailable for ${document.uri.toString()}`);

      webviewPanel.webview.postMessage({
        type: 'tabCompletionResponse',
        requestId,
        insertText: null,
      });
      break;

    }

    case 'setTableFirstRowStickyDefault': {
      if (typeof message.sticky === 'boolean') {
        await ctx.setTableFirstRowStickyDefault(message.sticky);
      }
      break;
    }

    case 'ready': {
      const rawContent = ctx.getLastKnownContent();
      logOpenWithDebug('providerMessage.ready', {
        path: document.uri.fsPath,
        rawLength: rawContent.length,
        isDirty: document.isDirty,
      });
      const settings = ctx.getEditorSettings();
      const pendingCursor = consumePendingCursorForUri(document.uri);
      const activeEditor = vscode.window.activeTextEditor;
      const fallbackEditor = activeEditor && activeEditor.document.uri.toString() === document.uri.toString()
        ? activeEditor
        : vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
      const initialCursorLine = pendingCursor?.line ?? fallbackEditor?.selection.active.line ?? 0;
      const initialCursorCharacter = pendingCursor?.character ?? fallbackEditor?.selection.active.character ?? 0;

      // Remove settings comment and normalize to LF before sending to webview
      const contentWithoutComment = repairSerializedMarkdownContent(rawContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n'));

      // Build image path mapping
      const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);

      webviewPanel.webview.postMessage({
        type: 'init',
        content: contentWithoutComment,
        filename: ctx.getFilename(),
        filePath: document.uri.fsPath,
        fullWidth: settings.fullWidth,
        tocVisible: settings.tocVisible,
        tableWrap: settings.tableWrap,
        tableFirstRowStickyDefault: ctx.getTableFirstRowStickyDefault(),
        initialCursorLine,
        initialCursorCharacter,
        initialTotalLines: Math.max(1, document.lineCount),
        terminalAppearance: readTerminalAppearance(),
        imagePathMap: imagePathMap,
      });
      logOpenWithDebug('providerMessage.initPosted', {
        path: document.uri.fsPath,
        initLength: contentWithoutComment.length,
      });
      break;
    }

    case 'copyTextToClipboard': {
      const text = typeof message.text === 'string' ? message.text : '';
      const successMessage = typeof message.successMessage === 'string' ? message.successMessage : 'Copied';
      if (!text) {
        webviewPanel.webview.postMessage({ type: 'clipboardCopyFailed', message: 'Nothing to copy.' });
        break;
      }
      try {
        await vscode.env.clipboard.writeText(text);
        webviewPanel.webview.postMessage({ type: 'clipboardCopyCompleted', message: successMessage });
      } catch (error) {
        webviewPanel.webview.postMessage({ type: 'clipboardCopyFailed', message: toErrorMessage(error) });
      }
      break;
    }

    case 'openTerminal': {
      if (document.uri.scheme !== 'file') {
        webviewPanel.webview.postMessage({
          type: 'terminalError',
          message: 'Only files on disk support the embedded terminal.',
        });
        break;
      }
      openTerminalForPanel(webviewPanel, path.dirname(document.uri.fsPath));
      break;
    }

    case 'terminalInput': {
      writeTerminalInput(webviewPanel, typeof message.data === 'string' ? message.data : '');
      break;
    }

    case 'terminalResize': {
      const cols = typeof message.cols === 'number' ? message.cols : 0;
      const rows = typeof message.rows === 'number' ? message.rows : 0;
      resizeTerminalForPanel(webviewPanel, cols, rows);
      break;
    }

    case 'terminalClose': {
      disposeTerminalForPanel(webviewPanel);
      break;
    }

    case 'openWithDebugLog': {
      const stage = typeof message.stage === 'string' ? message.stage : 'webview.unknown';
      const meta = typeof message.meta === 'object' && message.meta ? message.meta : {};
      logOpenWithDebug(`webview.${stage}`, {
        path: document.uri.fsPath,
        ...(meta as Record<string, unknown>),
      });
      break;
    }

    case 'rowResizeDebug': {
      const stage = typeof message.stage === 'string' ? message.stage : 'unknown';
      const data = typeof message.data === 'object' && message.data ? message.data : {};
      const payload = {
        path: document.uri.fsPath,
        ...(data as Record<string, unknown>),
      };
      console.info(`[EasyView RowResize] ${stage} ${JSON.stringify(payload)}`);
      logOpenWithDebug(`rowResize.${stage}`, payload);
      break;
    }

    case 'save': {
      enqueueOperation(ctx, 'save document', async () => {
        // Guard save with isUpdatingDocument to prevent formatter-triggered
        // onDidChangeTextDocument from being treated as external (AI) changes
        ctx.setIsUpdatingDocument(true);
        try {
          await document.save();
          // If formatters changed content during save, sync back without AI flag
          const newContent = document.getText();
          if (newContent !== ctx.getLastKnownContent()) {
            ctx.setLastKnownContent(newContent);
            const contentWithoutComment = repairSerializedMarkdownContent(newContent.replace(SETTINGS_COMMENT_RE, '').replace(/\r\n/g, '\n'));
            const imagePathMap = buildImagePathMap(contentWithoutComment, webviewPanel.webview, document.uri);
            ctx.setIsUpdatingWebview(true);
            webviewPanel.webview.postMessage({
              type: 'documentChanged',
              content: contentWithoutComment,
              imagePathMap,
              isUndoRedo: true, // Not an external/AI change
              skipAutoScroll: true,
            });
            setTimeout(() => { ctx.setIsUpdatingWebview(false); }, 100);
            await ctx.refreshGitChanges?.();
          }
        } finally {
          ctx.setIsUpdatingDocument(false);
        }
      });
      break;
    }

    case 'webviewRuntimeError': {
      const source = typeof message.source === 'string' ? message.source : 'unknown';
      const messageText = typeof message.message === 'string' ? message.message : 'Unknown webview runtime error';
      const stack = typeof message.stack === 'string' ? message.stack : '';
      console.error(`[InLineMd][webview:${source}] ${messageText}${stack ? `\n${stack}` : ''}`);
      vscode.window.showErrorMessage(`EasyView_Md webview error (${source}): ${messageText}`);
      break;
    }

    case 'stageFile': {
      if (document.uri.scheme !== 'file') {
        vscode.window.showInformationMessage('Only files on disk can be staged.');
        break;
      }

      enqueueOperation(ctx, 'stage markdown file', async () => {
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
      break;
    }

    case 'generateCommitMessage': {
      if (document.uri.scheme !== 'file') {
        webviewPanel.webview.postMessage({
          type: 'commitMessageGenerationFailed',
          message: 'Only files on disk can be committed.',
        });
        break;
      }

      enqueueOperation(ctx, 'generate commit message', async () => {
        ctx.setIsUpdatingDocument(true);
        try {
          await document.save();
        } finally {
          ctx.setIsUpdatingDocument(false);
        }

        try {
          const result = await generateCommitMessageForCurrentFile(document);
          webviewPanel.webview.postMessage({
            type: 'commitMessageGenerated',
            message: result.message,
            source: result.source,
          });
        } catch (error) {
          const messageText = toErrorMessage(error);
          webviewPanel.webview.postMessage({
            type: 'commitMessageGenerationFailed',
            message: messageText,
          });
          vscode.window.showErrorMessage(`Failed to generate commit message: ${messageText}`);
        }
      });
      break;
    }

    case 'commitFile': {
      if (document.uri.scheme !== 'file') {
        webviewPanel.webview.postMessage({
          type: 'commitFileFailed',
          message: 'Only files on disk can be committed.',
        });
        break;
      }

      const commitMessage = typeof message.message === 'string' ? sanitizeCommitMessage(message.message) : '';
      if (!commitMessage) {
        webviewPanel.webview.postMessage({
          type: 'commitFileFailed',
          message: 'Commit message cannot be empty.',
        });
        break;
      }

      enqueueOperation(ctx, 'commit current markdown file', async () => {
        ctx.setIsUpdatingDocument(true);
        try {
          await document.save();
        } finally {
          ctx.setIsUpdatingDocument(false);
        }

        try {
          const gitContext = await resolveGitFileContext(document);
          if (!gitContext.status) {
            webviewPanel.webview.postMessage({
              type: 'commitFileFailed',
              message: 'Current file has no Git changes to commit.',
            });
            return;
          }

          await execGit(['add', '--', gitContext.relativePath], gitContext.root);
          await execGit(['commit', '-m', commitMessage, '--', gitContext.relativePath], gitContext.root);
          await ctx.refreshGitChanges?.();
          const successText = `Committed: ${path.basename(document.uri.fsPath)}`;
          webviewPanel.webview.postMessage({
            type: 'commitFileCompleted',
            message: successText,
          });
          vscode.window.showInformationMessage(successText);
        } catch (error) {
          const messageText = toErrorMessage(error);
          webviewPanel.webview.postMessage({
            type: 'commitFileFailed',
            message: messageText,
          });
          vscode.window.showErrorMessage(`Failed to commit file: ${messageText}`);
        }
      });
      break;
    }

    case 'syncFile': {
      if (document.uri.scheme !== 'file') {
        webviewPanel.webview.postMessage({
          type: 'syncFileFailed',
          message: 'Only files on disk can be synced.',
        });
        break;
      }

      const commitMessage = typeof message.message === 'string' ? sanitizeCommitMessage(message.message) : '';
      if (!commitMessage) {
        webviewPanel.webview.postMessage({
          type: 'syncFileFailed',
          message: 'Commit message cannot be empty.',
        });
        break;
      }

      enqueueOperation(ctx, 'sync current markdown file', async () => {
        ctx.setIsUpdatingDocument(true);
        try {
          await document.save();
        } finally {
          ctx.setIsUpdatingDocument(false);
        }

        try {
          const gitContext = await resolveGitFileContext(document);
          let successText = `Synced: ${path.basename(document.uri.fsPath)}`;

          if (gitContext.status) {
            await execGit(['add', '--', gitContext.relativePath], gitContext.root);
            await execGit(['commit', '-m', commitMessage, '--', gitContext.relativePath], gitContext.root);
            await execGit(['push'], gitContext.root);
          } else {
            const pushState = await resolveGitPushState(gitContext.root);
            if (!pushState.hasUpstream) {
              webviewPanel.webview.postMessage({
                type: 'syncFileFailed',
                message: 'Current branch has no upstream remote configured.',
              });
              return;
            }
            if (pushState.ahead <= 0) {
              webviewPanel.webview.postMessage({
                type: 'syncFileFailed',
                message: 'Current branch has no unpushed commits to sync.',
              });
              return;
            }
            await execGit(['push'], gitContext.root);
            successText = `Pushed current branch: ${path.basename(document.uri.fsPath)}`;
          }

          await ctx.refreshGitChanges?.();
          webviewPanel.webview.postMessage({
            type: 'syncFileCompleted',
            message: successText,
          });
          vscode.window.showInformationMessage(successText);
        } catch (error) {
          const messageText = toErrorMessage(error);
          webviewPanel.webview.postMessage({
            type: 'syncFileFailed',
            message: messageText,
          });
          vscode.window.showErrorMessage(`Failed to sync file: ${messageText}`);
        }
      });
      break;
    }

    case 'syncOpenEditorShortcut': {
      const shortcut = typeof message.shortcut === 'string' ? message.shortcut.trim() : '';
      if (!shortcut) break;
      try {
        await syncOpenEditorShortcutToUserKeybindings(shortcut);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        console.warn('[InLineMd] Failed to sync keybindings shortcut:', messageText);
      }
      break;
    }

    case 'openWithEasyView': {
      try {
        await vscode.commands.executeCommand('inlineMd.openEditor', document.uri);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to open with EasyView_Md: ${messageText}`);
      }
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
      const dropPos = typeof message.pos === 'number' ? message.pos : undefined;
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

    case 'pasteImage': {
      const dataUrl = typeof message.dataUrl === 'string' ? message.dataUrl : '';
      const mimeType = typeof message.mimeType === 'string' ? message.mimeType : 'image/png';
      const insertPos = typeof message.pos === 'number' ? message.pos : undefined;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
      if (!match) break;

      try {
        const effectiveMime = (match[1] || mimeType).toLowerCase();
        const base64 = match[2].replace(/\s+/g, '');
        const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
        const extension = mimeTypeToImageExtension(effectiveMime);
        const { directory, file } = allocatePastedImageTarget(document, extension);
        await vscode.workspace.fs.createDirectory(directory);
        await vscode.workspace.fs.writeFile(file, bytes);

        const fileDir = vscode.Uri.file(path.dirname(file.fsPath));
        const currentRoots = webviewPanel.webview.options.localResourceRoots || [];
        const alreadyIncluded = currentRoots.some((root) => file.fsPath.startsWith(root.fsPath));
        if (!alreadyIncluded) {
          webviewPanel.webview.options = {
            ...webviewPanel.webview.options,
            localResourceRoots: [...currentRoots, fileDir],
          };
        }

        const webviewUri = webviewPanel.webview.asWebviewUri(file);
        const docDir = path.dirname(document.uri.fsPath);
        let relPath = path.relative(docDir, file.fsPath).replace(/\\/g, '/');
        if (!relPath.startsWith('.') && !relPath.startsWith('/')) {
          relPath = './' + relPath;
        }

        webviewPanel.webview.postMessage({
          type: 'imageSelected',
          src: webviewUri.toString(),
          originalSrc: relPath,
          pos: insertPos,
        });
      } catch (error) {
        console.error('[InLineMd] Failed to persist pasted image:', error);
        vscode.window.showErrorMessage('Failed to save pasted image as a file.');
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

    case 'exportDocx': {
      const markdown = typeof message.markdown === 'string' ? message.markdown : '';
      if (!markdown.trim()) {
        vscode.window.showInformationMessage('Nothing to export as DOCX.');
        break;
      }

      const docxDocDir = path.dirname(document.uri.fsPath);
      const defaultName = ctx.getFilename();
      const title = typeof message.title === 'string' && message.title.trim()
        ? message.title.trim()
        : defaultName;

      const docxSaveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(docxDocDir, defaultName + '.docx')),
        filters: { 'Word Document': ['docx'] },
      });

      if (!docxSaveUri) break;

      try {
        const mermaidImages = Array.isArray(message.mermaidImages) ? message.mermaidImages : [];
        const asciiImages = Array.isArray(message.asciiImages) ? message.asciiImages : [];
        const docxFile = await markdownToDocx(markdown, title, docxDocDir, mermaidImages, asciiImages);
        const buffer = await Packer.toBuffer(docxFile);
        await vscode.workspace.fs.writeFile(docxSaveUri, buffer);

        const action = await vscode.window.showInformationMessage(
          `DOCX exported to ${path.basename(docxSaveUri.fsPath)}`,
          'Open File'
        );
        if (action === 'Open File') {
          openWithDefaultApp(docxSaveUri.fsPath);
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('EBUSY') || msg.includes('resource busy')) {
          vscode.window.showErrorMessage(
            'Cannot save DOCX: the file is open in another program. Close it and try again.'
          );
        } else {
          vscode.window.showErrorMessage(`DOCX export failed: ${msg}`);
        }
      }
      break;
    }


  }
}
