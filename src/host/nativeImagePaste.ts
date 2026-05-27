import { Buffer } from 'buffer';
import * as path from 'path';
import * as vscode from 'vscode';

const MARKDOWN_IMAGE_PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Text.append('markdown', 'image', 'file');
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

type PastedImagePayload = {
  bytes: Uint8Array;
  extension: string;
};

function toRelativeMarkdownPath(fromFile: string, toFile: string): string {
  let relPath = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
  if (!relPath.startsWith('.') && !relPath.startsWith('/')) {
    relPath = './' + relPath;
  }
  return relPath;
}

function sanitizeBaseName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'image';
}

function allocateImageTarget(document: vscode.TextDocument, extension: string): { directory: vscode.Uri; file: vscode.Uri } {
  const docDir = path.dirname(document.uri.fsPath);
  const stem = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
  const safeStem = sanitizeBaseName(stem);
  const directory = vscode.Uri.file(path.join(docDir, `${safeStem}.assets`));
  const filename = `${safeStem}-${Date.now()}${extension}`;
  const file = vscode.Uri.joinPath(directory, filename);
  return { directory, file };
}

async function extractFromImageFile(dataTransfer: vscode.DataTransfer): Promise<PastedImagePayload | undefined> {
  for (const [mimeType, item] of dataTransfer) {
    if (!mimeType.toLowerCase().startsWith('image/')) continue;
    const file = item.asFile();
    if (!file) continue;
    const bytes = await file.data();
    const extension = path.extname(file.name) || IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] || '.png';
    return { bytes, extension };
  }

  const filesItem = dataTransfer.get('files');
  const file = filesItem?.asFile();
  if (!file) return undefined;

  const inferredExtension = path.extname(file.name) || '.png';
  const bytes = await file.data();
  return { bytes, extension: inferredExtension };
}

async function extractFromHtmlDataUri(dataTransfer: vscode.DataTransfer): Promise<PastedImagePayload | undefined> {
  const htmlItem = dataTransfer.get('text/html');
  if (!htmlItem) return undefined;

  const html = await htmlItem.asString();
  const match = html.match(/src=["']data:(image\/[a-zA-Z0-9.+-]+);base64,([^"']+)["']/i);
  if (!match) return undefined;

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  const extension = IMAGE_MIME_EXTENSIONS[mimeType] || '.png';
  return {
    bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
    extension,
  };
}

async function extractFromPlainTextDataUri(dataTransfer: vscode.DataTransfer): Promise<PastedImagePayload | undefined> {
  const textItem = dataTransfer.get('text/plain');
  if (!textItem) return undefined;

  const text = (await textItem.asString()).trim();
  const match = text.match(/!\[[^\]]*]\(\s*data:(image\/[a-zA-Z0-9.+-]+);base64,([^)]+)\s*\)/i);
  if (!match) return undefined;

  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, '');
  const extension = IMAGE_MIME_EXTENSIONS[mimeType] || '.png';
  return {
    bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
    extension,
  };
}

async function extractPastedImage(dataTransfer: vscode.DataTransfer): Promise<PastedImagePayload | undefined> {
  return (
    (await extractFromImageFile(dataTransfer))
    ?? (await extractFromHtmlDataUri(dataTransfer))
    ?? (await extractFromPlainTextDataUri(dataTransfer))
  );
}

export function registerNativeMarkdownImagePaste(): vscode.Disposable {
  const selector: vscode.DocumentSelector = [
    { language: 'markdown', scheme: 'file' },
    { language: 'mdx', scheme: 'file' },
  ];

  const provider: vscode.DocumentPasteEditProvider = {
    async provideDocumentPasteEdits(document, _ranges, dataTransfer) {
      const payload = await extractPastedImage(dataTransfer);
      if (!payload) return [];

      const { directory, file } = allocateImageTarget(document, payload.extension);
      await vscode.workspace.fs.createDirectory(directory);

      const edit = new vscode.DocumentPasteEdit(
        `![](${toRelativeMarkdownPath(document.uri.fsPath, file.fsPath)})`,
        'Paste Image as File',
        MARKDOWN_IMAGE_PASTE_KIND,
      );

      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.createFile(file, {
        contents: payload.bytes,
        overwrite: false,
        ignoreIfExists: false,
      });
      edit.additionalEdit = workspaceEdit;
      return [edit];
    },
  };

  return vscode.languages.registerDocumentPasteEditProvider(selector, provider, {
    providedPasteEditKinds: [MARKDOWN_IMAGE_PASTE_KIND],
    pasteMimeTypes: ['image/*', 'files', 'text/html', 'text/plain'],
  });
}
