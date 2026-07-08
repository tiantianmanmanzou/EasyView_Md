import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFile, spawn } from 'child_process';
import { Document as DocxDocument, HeadingLevel, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import { SETTINGS_COMMENT_RE, type EditorSettings, computeMinimalDiff, repairSerializedMarkdownContent } from './providerUtils';
import { buildImagePathMap } from './providerImageManager';
import { downloadFile, ExportImage } from './providerExportHandler';
import { roundPdfCorners } from './pdfRoundCorners';
import { ensureNativeMarkdownEditorFont } from './nativeEditorFont';
import { suppressConflictingMarkdownInlineDecorations } from './conflictingExtensions';
import { consumePendingCursorForUri } from './openCursorContext';
import { logOpenWithDebug } from './openWithDebug';
import { disposeTerminalForPanel, openTerminalForPanel, resizeTerminalForPanel, writeTerminalInput } from './terminalSessionManager';

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

function getDocumentLineOffset(document: vscode.TextDocument): number {
  const match = document.getText().match(SETTINGS_COMMENT_RE);
  if (!match?.[0]) {
    return 0;
  }
  return match[0].split(/\r?\n/).length - 1;
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

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

type DocxImageType = 'jpg' | 'png' | 'gif' | 'bmp';

function inferDocxImageTypeByPath(imagePath: string): DocxImageType | null {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.gif') return 'gif';
  if (ext === '.bmp') return 'bmp';
  return null;
}

function inferDocxImageTypeByBytes(data: Uint8Array): DocxImageType | null {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47
    && data[4] === 0x0D && data[5] === 0x0A && data[6] === 0x1A && data[7] === 0x0A) {
    return 'png';
  }
  if (data.length >= 3 && data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    return 'jpg';
  }
  if (data.length >= 6) {
    const h = String.fromCharCode(data[0], data[1], data[2], data[3], data[4], data[5]);
    if (h === 'GIF87a' || h === 'GIF89a') return 'gif';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4D) {
    return 'bmp';
  }
  return null;
}

function parseMarkdownImageTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  if (!target) return '';
  if (target.startsWith('<') && target.endsWith('>')) {
    return target.slice(1, -1).trim();
  }
  const titleStart = target.match(/\s+["'][^"']*["']\s*$/);
  if (titleStart) {
    return target.slice(0, titleStart.index).trim();
  }
  return target;
}

async function resolveDocxImageData(imageSrcRaw: string, docDir: string): Promise<{ data: Buffer; type: DocxImageType } | null> {
  const imageSrc = imageSrcRaw.trim();
  if (!imageSrc) return null;

  if (imageSrc.startsWith('data:image/')) {
    const match = imageSrc.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;
    const mimeSubtype = match[1].toLowerCase();
    const base64 = match[2].replace(/\s+/g, '');
    const data = Buffer.from(base64, 'base64');
    const typeMap: Record<string, DocxImageType> = {
      'png': 'png',
      'jpg': 'jpg',
      'jpeg': 'jpg',
      'gif': 'gif',
      'bmp': 'bmp',
    };
    const type = typeMap[mimeSubtype] ?? inferDocxImageTypeByBytes(data);
    if (!type) return null;
    return { data, type };
  }

  if (imageSrc.startsWith('http://') || imageSrc.startsWith('https://')) {
    const raw = await downloadFile(imageSrc);
    const data = Buffer.from(raw);
    const type = inferDocxImageTypeByPath(imageSrc) ?? inferDocxImageTypeByBytes(data);
    if (!type) return null;
    return { data, type };
  }

  let decoded = imageSrc;
  try {
    decoded = decodeURIComponent(imageSrc);
  } catch {
    decoded = imageSrc;
  }

  const absolutePath = path.isAbsolute(decoded) ? decoded : path.resolve(docDir, decoded);
  const fileData = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath));
  const data = Buffer.from(fileData);
  const type = inferDocxImageTypeByPath(decoded) ?? inferDocxImageTypeByBytes(data);
  if (!type) return null;
  return { data, type };
}

function getImageDimensions(type: DocxImageType, data: Buffer): { width: number; height: number } | null {
  try {
    if (type === 'png' && data.length >= 24) {
      return {
        width: data.readUInt32BE(16),
        height: data.readUInt32BE(20),
      };
    }
    if (type === 'gif' && data.length >= 10) {
      return {
        width: data.readUInt16LE(6),
        height: data.readUInt16LE(8),
      };
    }
    if (type === 'bmp' && data.length >= 26) {
      return {
        width: Math.abs(data.readInt32LE(18)),
        height: Math.abs(data.readInt32LE(22)),
      };
    }
    if (type === 'jpg') {
      let offset = 2;
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xFF) {
          offset++;
          continue;
        }
        const marker = data[offset + 1];
        offset += 2;
        if (marker === 0xD8 || marker === 0xD9) continue;
        if (offset + 1 >= data.length) break;
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) break;
        const isSofMarker =
          (marker >= 0xC0 && marker <= 0xC3)
          || (marker >= 0xC5 && marker <= 0xC7)
          || (marker >= 0xC9 && marker <= 0xCB)
          || (marker >= 0xCD && marker <= 0xCF);
        if (isSofMarker && length >= 7) {
          return {
            height: data.readUInt16BE(offset + 3),
            width: data.readUInt16BE(offset + 5),
          };
        }
        offset += length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function fitImageIntoBounds(
  width: number,
  height: number,
  maxWidth = 640,
  maxHeight = 420
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 520, height: 300 };
  }
  const widthRatio = maxWidth / width;
  const heightRatio = maxHeight / height;
  const ratio = Math.min(widthRatio, heightRatio, 1);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

async function markdownToDocx(markdown: string, title: string, docDir: string): Promise<DocxDocument> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const paragraphs: Paragraph[] = [];
  const numberedReference = 'easyview-numbering';

  paragraphs.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun(title || 'Document')],
    spacing: { after: 280 },
  }));

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    const trimmed = line.trim();

    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: '' }));
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = stripMarkdownInline(headingMatch[2]);
      const headingMap: Record<number, HeadingLevel> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6,
      };
      paragraphs.push(new Paragraph({
        heading: headingMap[level] ?? HeadingLevel.HEADING_3,
        children: [new TextRun(text)],
      }));
      continue;
    }

    const bulletMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
      const level = Math.max(0, Math.floor((bulletMatch[1]?.length ?? 0) / 2));
      paragraphs.push(new Paragraph({
        bullet: { level: Math.min(level, 8) },
        children: [new TextRun(stripMarkdownInline(bulletMatch[3]))],
      }));
      continue;
    }

    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (orderedMatch) {
      const level = Math.max(0, Math.floor((orderedMatch[1]?.length ?? 0) / 2));
      paragraphs.push(new Paragraph({
        numbering: {
          reference: numberedReference,
          level: Math.min(level, 8),
        },
        children: [new TextRun(stripMarkdownInline(orderedMatch[2]))],
      }));
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      paragraphs.push(new Paragraph({
        indent: { left: 480 },
        border: { left: { color: '999999', size: 6, space: 8, style: 'single' } },
        children: [new TextRun(stripMarkdownInline(quoteMatch[1]))],
      }));
      continue;
    }

    if (/^---+$/.test(trimmed) || /^___+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      paragraphs.push(new Paragraph({
        thematicBreak: true,
      }));
      continue;
    }

    // Support Pandoc-style image attributes like:
    // ![alt](path){width=357}
    // ![alt](path) { width=357 }
    // so they are not emitted as plain text in DOCX.
    const imageMatches = [...line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)(?:\s*\{[^}]+\})?/g)];
    if (imageMatches.length > 0) {
      const children: (TextRun | ImageRun)[] = [];
      let cursor = 0;
      for (const match of imageMatches) {
        const matchText = match[0];
        const altText = (match[1] ?? '').trim();
        const targetRaw = match[2] ?? '';
        const imageSrc = parseMarkdownImageTarget(targetRaw);
        const start = match.index ?? 0;
        const end = start + matchText.length;

        const before = line.slice(cursor, start);
        if (before.trim()) {
          children.push(new TextRun(stripMarkdownInline(before)));
        }

        try {
          const imageResolved = await resolveDocxImageData(imageSrc, docDir);
          if (imageResolved) {
            const dimensions = getImageDimensions(imageResolved.type, imageResolved.data);
            const fitted = fitImageIntoBounds(dimensions?.width ?? 520, dimensions?.height ?? 300);
            children.push(new ImageRun({
              type: imageResolved.type,
              data: imageResolved.data,
              transformation: {
                width: fitted.width,
                height: fitted.height,
              },
            }));
          } else {
            children.push(new TextRun(`[Image: ${altText || imageSrc}]`));
          }
        } catch {
          children.push(new TextRun(`[Image: ${altText || imageSrc}]`));
        }
        cursor = end;
      }
      const after = line.slice(cursor);
      if (after.trim()) {
        children.push(new TextRun(stripMarkdownInline(after)));
      }
      if (children.length > 0) {
        paragraphs.push(new Paragraph({ children }));
      } else {
        paragraphs.push(new Paragraph({ children: [new TextRun(stripMarkdownInline(trimmed))] }));
      }
      continue;
    }

    paragraphs.push(new Paragraph({
      children: [new TextRun(stripMarkdownInline(trimmed))],
    }));
  }

  return new DocxDocument({
    numbering: {
      config: [
        {
          reference: numberedReference,
          levels: Array.from({ length: 9 }).map((_, idx) => ({
            level: idx,
            format: 'decimal',
            text: `%${idx + 1}.`,
            alignment: 'start',
            style: {
              paragraph: {
                indent: { left: 720 + idx * 360, hanging: 260 },
              },
            },
          })),
        },
      ],
    },
    sections: [{ children: paragraphs }],
  });
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
  message: any
): Promise<void> {
  const { webviewPanel, document } = ctx;

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

        try {
          await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        } catch {
          // Native inline suggestions remain available even if explicit triggering is unavailable.
        }
        },
        (messageText) => {
          vscode.window.showErrorMessage(`Failed to open native source mode: ${messageText}`);
        }
      );
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
        const docxFile = await markdownToDocx(markdown, title, docxDocDir);
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
