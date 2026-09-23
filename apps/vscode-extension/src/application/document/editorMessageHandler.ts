import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { type EditorSettings, computeMinimalDiff, repairSerializedMarkdownContent } from '../../adapters/vscode/providerUtils';
import { SETTINGS_COMMENT_RE } from '@easyview/markdown-core/editor-settings';
import { buildImagePathMap } from '../../adapters/vscode/providerImageManager';
import { roundPdfCorners } from '../export/pdfRoundCorners';
import { ensureNativeMarkdownEditorFont } from '../../native-editor/nativeEditorFont';
import { suppressConflictingMarkdownInlineDecorations } from '../../native-editor/conflictingExtensions';
import { consumePendingCursorForUri } from './openCursorContext';
import { logOpenWithDebug } from './openWithDebug';
import { disposeTerminalForPanel, openTerminalForPanel, resizeTerminalForPanel, writeTerminalInput } from '../terminal/terminalSessionManager';
import type { EditorToHostMessage } from '@easyview/contracts/protocol';
import type { VscodeEditorHostActionMessage } from '../../adapters/vscode/vscodeProtocol';
import { handleWebviewExportMessage } from '../export/providerWebviewExportHandlers';
import { showExportCompletionNotification } from '../export/exportCompletionNotification';
import {
  commitFile as commitGitFile,
  findRepository,
  getFileDiff,
  getFileStatus,
  getUpstreamStatus,
  markdownToDocxBuffer,
  pickImage as pickImageFile,
  readImageAsDataUrl,
  savePastedImage,
  push as pushGitRepository,
  stageFile as stageGitFile,
} from '@easyview/node-runtime';
import { isEasyViewThemeMode } from '@easyview/contracts';
import { isDiskBackedMarkdownUri } from './markdownUri';
import { resolveMarkdownDiskUri } from './openMarkdownEditor';
import { broadcastProductTheme, readProductTheme, writeProductTheme } from '../../theme/productThemeBridge';

function diskFsPath(document: vscode.TextDocument): string {
  return resolveMarkdownDiskUri(document.uri).fsPath;
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
    `  { "key": "${DEFAULT_OPEN_EDITOR_KEY}", "command": "-easyviewMd.openEditor", "when": "${OPEN_EDITOR_WHEN}" },`,
    `  { "key": "${normalized}", "command": "easyviewMd.openEditor", "when": "${OPEN_EDITOR_WHEN}" }`,
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
  const repository = await findRepository(diskFsPath(document));
  if (!repository) throw new Error('Current file is not in a Git repository.');

  const fileStatus = await getFileStatus(repository.rootPath, diskFsPath(document));
  const fileDiff = await getFileDiff(repository.rootPath, diskFsPath(document));
  let diff = fileDiff.diff;
  if (!diff.trim() && fileStatus.isUntracked) {
    diff = [
      `diff --git a/${fileStatus.relativePath} b/${fileStatus.relativePath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${fileStatus.relativePath}`,
      '@@',
      ...document.getText().split(/\r?\n/).slice(0, 400).map((line) => `+${line}`),
    ].join('\n');
  }
  return {
    root: repository.rootPath,
    relativePath: fileStatus.relativePath,
    status: fileStatus.status.trim(),
    diff,
  };
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
      return ensureBilingualCommitMessageFormat(current, path.basename(diskFsPath(document)), '', '') || null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const current = typeof repo.inputBox?.value === 'string' ? repo.inputBox.value.trim() : '';
  return current ? ensureBilingualCommitMessageFormat(current, path.basename(diskFsPath(document)), '', '') || null : null;
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

  const fileName = path.basename(diskFsPath(document));
  try {
    const aiMessage = await generateCommitMessageWithVsCodeLm(fileName, context.status, context.diff);
    if (aiMessage) {
      return { message: aiMessage, source: 'Generated by VS Code AI' };
    }
  } catch (error) {
    console.warn('[EasyView_Md] VS Code language model commit message generation failed:', toErrorMessage(error));
  }

  try {
    const scmMessage = await generateCommitMessageWithScmCommand(document);
    if (scmMessage) {
      return { message: scmMessage, source: 'Generated by VS Code SCM AI' };
    }
  } catch (error) {
    console.warn('[EasyView_Md] VS Code SCM commit message generation failed:', toErrorMessage(error));
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
  extensionContext: vscode.ExtensionContext;
  getFilename: () => string;
  getCanonicalContent: () => string;
  applyCanonicalContent: (content: string, settings: EditorSettings) => Promise<void>;
  getSyncRevision: () => number;
  postSnapshot: (reason?: 'initial' | 'visible' | 'resync' | 'reload') => void;
  enqueueOperation: (name: string, operation: () => Promise<void>, onError?: (message: string) => void) => void;
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
  await ctx.applyCanonicalContent(repairSerializedMarkdownContent(editContent.replace(SETTINGS_COMMENT_RE, '')), settings);
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
  ctx.enqueueOperation(operationName, operation, onError);
}

function ensureImageResourceRoot(webview: vscode.Webview, filePath: string): void {
  const fileDirectory = vscode.Uri.file(path.dirname(filePath));
  const currentRoots = webview.options.localResourceRoots ?? [];
  if (currentRoots.some((root) => filePath.startsWith(root.fsPath))) return;
  webview.options = {
    ...webview.options,
    localResourceRoots: [...currentRoots, fileDirectory],
  };
}

/** Handle VS Code-only host actions outside the platform-neutral editor protocol. */
export async function handleVscodeEditorHostAction(
  ctx: MessageHandlerContext,
  message: VscodeEditorHostActionMessage,
): Promise<void> {
  const { webviewPanel, document } = ctx;

  if (message.type === 'vscode.persistOpenEditorShortcut') {
    try {
      await syncOpenEditorShortcutToUserKeybindings(message.shortcut.trim());
    } catch (error) {
      console.warn('[EasyView_Md] Failed to sync keybindings shortcut:', toErrorMessage(error));
    }
    return;
  }

  const request = message.request;
  enqueueOperation(
    ctx,
    'open native source mode',
    async () => {
      await syncWebviewContentToDocument(ctx, request.content, {
        fullWidth: request.fullWidth,
        tocVisible: request.tocVisible,
        tableWrap: request.tableWrap,
      });
      await ensureNativeMarkdownEditorFont(document);

      const targetLine = Math.min(request.line, Math.max(0, document.lineCount - 1));
      const targetCharacter = Math.min(request.character, document.lineAt(targetLine).text.length);
      const position = new vscode.Position(targetLine, targetCharacter);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: webviewPanel.viewColumn,
        preserveFocus: false,
        preview: false,
      });
      await suppressConflictingMarkdownInlineDecorations(editor);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    },
    (messageText) => {
      vscode.window.showErrorMessage(`Failed to open native source mode: ${messageText}`);
    },
  );
}

/**
 * Handle a single editor message. Extracted from resolveCustomTextEditor
 * to keep the main provider file focused on lifecycle management.
 */
export async function handleWebviewMessage(
  ctx: MessageHandlerContext,
  message: EditorToHostMessage
): Promise<void> {
  const { webviewPanel, document } = ctx;

  if (message.type === 'exportXlsx' || message.type === 'exportHtml') {
    await handleWebviewExportMessage(ctx, message);
    return;
  }

  switch (message.type) {
    case 'requestTabCompletion': {
      const requestId = message.requestId;
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
      ctx.postSnapshot('initial');
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
      if (!isDiskBackedMarkdownUri(document.uri)) {
        webviewPanel.webview.postMessage({
          type: 'terminalError',
          message: 'Only files on disk support the embedded terminal.',
        });
        break;
      }
      openTerminalForPanel(webviewPanel, path.dirname(diskFsPath(document)));
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
        path: diskFsPath(document),
        ...(meta as Record<string, unknown>),
      });
      break;
    }

    case 'rowResizeDebug': {
      const stage = typeof message.stage === 'string' ? message.stage : 'unknown';
      const data = typeof message.data === 'object' && message.data ? message.data : {};
      const payload = {
        path: diskFsPath(document),
        ...(data as Record<string, unknown>),
      };
      console.info(`[EasyView RowResize] ${stage} ${JSON.stringify(payload)}`);
      logOpenWithDebug(`rowResize.${stage}`, payload);
      break;
    }

    case 'save': {
      enqueueOperation(ctx, 'save document', async () => {
        await document.save();
        await ctx.refreshGitChanges?.();
      });
      break;
    }

    case 'webviewRuntimeError': {
      const source = typeof message.source === 'string' ? message.source : 'unknown';
      const messageText = typeof message.message === 'string' ? message.message : 'Unknown editor runtime error';
      const stack = typeof message.stack === 'string' ? message.stack : '';
      console.error(`[EasyView_Md][webview:${source}] ${messageText}${stack ? `\n${stack}` : ''}`);
      vscode.window.showErrorMessage(`EasyView_Md webview error (${source}): ${messageText}`);
      break;
    }

    case 'stageFile': {
      if (!isDiskBackedMarkdownUri(document.uri)) {
        webviewPanel.webview.postMessage({
          type: 'stageFileFailed',
          message: 'Only files on disk can be staged.',
        });
        break;
      }

      enqueueOperation(ctx, 'stage markdown file', async () => {
        await document.save();

        try {
          const repository = await findRepository(diskFsPath(document));
          if (!repository) throw new Error('Current file is not in a Git repository.');
          await stageGitFile(repository.rootPath, diskFsPath(document));
          await ctx.refreshGitChanges?.();
          webviewPanel.webview.postMessage({
            type: 'stageFileCompleted',
            message: `Staged: ${path.basename(diskFsPath(document))}`,
          });
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          webviewPanel.webview.postMessage({
            type: 'stageFileFailed',
            message: `Failed to stage file: ${messageText}`,
          });
        }
      });
      break;
    }

    case 'generateCommitMessage': {
      if (!isDiskBackedMarkdownUri(document.uri)) {
        webviewPanel.webview.postMessage({
          type: 'commitMessageGenerationFailed',
          message: 'Only files on disk can be committed.',
        });
        break;
      }

      enqueueOperation(ctx, 'generate commit message', async () => {
        await document.save();

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
      if (!isDiskBackedMarkdownUri(document.uri)) {
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
        await document.save();

        try {
          const gitContext = await resolveGitFileContext(document);
          if (!gitContext.status) {
            webviewPanel.webview.postMessage({
              type: 'commitFileFailed',
              message: 'Current file has no Git changes to commit.',
            });
            return;
          }

          await commitGitFile(gitContext.root, diskFsPath(document), commitMessage);
          await ctx.refreshGitChanges?.();
          const successText = `Committed: ${path.basename(diskFsPath(document))}`;
          webviewPanel.webview.postMessage({
            type: 'commitFileCompleted',
            message: successText,
          });
        } catch (error) {
          const messageText = toErrorMessage(error);
          webviewPanel.webview.postMessage({
            type: 'commitFileFailed',
            message: messageText,
          });
        }
      });
      break;
    }

    case 'syncFile': {
      if (!isDiskBackedMarkdownUri(document.uri)) {
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
        await document.save();

        try {
          const gitContext = await resolveGitFileContext(document);
          let successText = `Synced: ${path.basename(diskFsPath(document))}`;

          if (gitContext.status) {
            await commitGitFile(gitContext.root, diskFsPath(document), commitMessage);
          }

          const pushState = await getUpstreamStatus(gitContext.root);
          if (!pushState.upstream) {
            webviewPanel.webview.postMessage({
              type: 'syncFileFailed',
              message: 'Current branch has no upstream remote configured.',
            });
            return;
          }
          if (!gitContext.status && pushState.ahead <= 0) {
            webviewPanel.webview.postMessage({
              type: 'syncFileFailed',
              message: 'Current branch has no unpushed commits to sync.',
            });
            return;
          }
          await pushGitRepository(gitContext.root);
          if (!gitContext.status) {
            successText = `Pushed current branch: ${path.basename(diskFsPath(document))}`;
          }

          await ctx.refreshGitChanges?.();
          webviewPanel.webview.postMessage({
            type: 'syncFileCompleted',
            message: successText,
          });
        } catch (error) {
          const messageText = toErrorMessage(error);
          webviewPanel.webview.postMessage({
            type: 'syncFileFailed',
            message: messageText,
          });
        }
      });
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
      const { requestId, originalSrc } = message;
      try {
        const base64 = await readImageAsDataUrl({
          documentPath: diskFsPath(document),
          source: originalSrc,
        });
        webviewPanel.webview.postMessage({ type: 'imageBase64Response', requestId, base64 });
      } catch (error) {
        console.warn('[EasyView_Md] Failed to load image for PDF:', originalSrc, error);
        webviewPanel.webview.postMessage({ type: 'imageBase64Response', requestId, base64: null });
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
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'] },
        defaultUri: vscode.Uri.file(path.dirname(diskFsPath(document))),
      });
      const selectedPath = result?.[0]?.fsPath;
      if (!selectedPath) break;

      try {
        const selected = await pickImageFile({
          documentPath: diskFsPath(document),
          selectPath: async () => selectedPath,
        });
        ensureImageResourceRoot(webviewPanel.webview, selected.sourcePath);
        webviewPanel.webview.postMessage({
          type: 'imageSelected',
          src: webviewPanel.webview.asWebviewUri(vscode.Uri.file(selected.sourcePath)).toString(),
          originalSrc: selected.relativePath,
          pos: message.pos,
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to select image: ${toErrorMessage(error)}`);
      }
      break;
    }

    case 'dropImages': {
      const dropPos = typeof message.pos === 'number' ? message.pos : undefined;
      const images: Array<{ src: string; originalSrc: string }> = [];
      for (const filePath of message.paths) {
        try {
          const selected = await pickImageFile({
            documentPath: diskFsPath(document),
            selectPath: async () => filePath,
          });
          ensureImageResourceRoot(webviewPanel.webview, selected.sourcePath);
          images.push({
            src: webviewPanel.webview.asWebviewUri(vscode.Uri.file(selected.sourcePath)).toString(),
            originalSrc: selected.relativePath,
          });
        } catch (error) {
          console.error('[EasyView_Md] Failed to process dropped image:', filePath, error);
        }
      }
      if (images.length > 0) {
        webviewPanel.webview.postMessage({ type: 'imagesDropped', images, pos: dropPos });
      }
      break;
    }

    case 'pasteImage': {
      try {
        const saved = await savePastedImage({
          documentPath: diskFsPath(document),
          dataUrl: message.dataUrl,
          preferredName: message.name,
        });
        ensureImageResourceRoot(webviewPanel.webview, saved.filePath);
        webviewPanel.webview.postMessage({
          type: 'imageSelected',
          src: webviewPanel.webview.asWebviewUri(vscode.Uri.file(saved.filePath)).toString(),
          originalSrc: saved.relativePath,
          pos: message.pos,
        });
      } catch (error) {
        console.error('[EasyView_Md] Failed to persist pasted image:', error);
        vscode.window.showErrorMessage(`Failed to save pasted image: ${toErrorMessage(error)}`);
      }
      break;
    }

    case 'exportPdfBase64': {
      const base64 = message.data;
      if (!base64 || typeof base64 !== 'string') break;

      const docDir = path.dirname(diskFsPath(document));
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
        showExportCompletionNotification(
          `PDF exported to ${path.basename(saveUri.fsPath)}`,
          saveUri.fsPath,
          'Open File',
        );
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

      const docxDocDir = path.dirname(diskFsPath(document));
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
        const buffer = await markdownToDocxBuffer(markdown, title, docxDocDir, mermaidImages, asciiImages, true);
        await vscode.workspace.fs.writeFile(docxSaveUri, buffer);
        showExportCompletionNotification(
          `DOCX exported to ${path.basename(docxSaveUri.fsPath)}`,
          docxSaveUri.fsPath,
          'Open File',
        );
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

    case 'productThemeChanged': {
      const mode = message.mode;
      if (!isEasyViewThemeMode(mode)) break;
      await writeProductTheme(ctx.extensionContext, mode);
      broadcastProductTheme(mode, webviewPanel);
      break;
    }

  }
}
