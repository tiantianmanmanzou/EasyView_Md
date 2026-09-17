import { Buffer } from 'buffer';
import * as path from 'path';
import * as vscode from 'vscode';
import { replaceHtmlImageDataUris, replaceInlineImageDataUris } from './nativeImagePasteTransform';

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

type PastedTextTransform = {
  text: string;
  files: Array<{ uri: vscode.Uri; bytes: Uint8Array }>;
  directory: vscode.Uri;
  title: string;
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

function allocateImageTarget(
  document: vscode.TextDocument,
  extension: string,
  batchId = Date.now(),
  index = 1,
): { directory: vscode.Uri; file: vscode.Uri } {
  const docDir = path.dirname(document.uri.fsPath);
  const stem = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
  const safeStem = sanitizeBaseName(stem);
  const directory = vscode.Uri.file(path.join(docDir, `${safeStem}.assets`));
  const filename = `${safeStem}-${batchId}-${index}${extension}`;
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

async function extractPastedImage(dataTransfer: vscode.DataTransfer): Promise<PastedImagePayload | undefined> {
  return await extractFromImageFile(dataTransfer);
}

function buildPayloadFromDataUri(dataUri: string, mimeType: string): PastedImagePayload {
  const base64 = dataUri.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  const extension = IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] || '.png';
  return {
    bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
    extension,
  };
}

function transformPastedText(document: vscode.TextDocument, raw: string, mode: 'markdown' | 'html'): PastedTextTransform | undefined {
  const batchId = Date.now();
  let counter = 0;
  let directory: vscode.Uri | undefined;
  const files: Array<{ uri: vscode.Uri; bytes: Uint8Array }> = [];

  const allocatePath = (dataUri: string, mimeType: string): string => {
    counter += 1;
    const payload = buildPayloadFromDataUri(dataUri, mimeType);
    const target = allocateImageTarget(document, payload.extension, batchId, counter);
    directory = target.directory;
    files.push({ uri: target.file, bytes: payload.bytes });
    return toRelativeMarkdownPath(document.uri.fsPath, target.file.fsPath);
  };

  const result = mode === 'markdown'
    ? replaceInlineImageDataUris(raw, allocatePath)
    : replaceHtmlImageDataUris(raw, allocatePath);

  if (!result.matched || !directory || files.length === 0) {
    return undefined;
  }

  return {
    text: result.replacement,
    files,
    directory,
    title: files.length === 1 ? 'Paste Image as File' : 'Paste Images as File References',
  };
}

async function extractPastedTextTransform(
  document: vscode.TextDocument,
  dataTransfer: vscode.DataTransfer,
): Promise<PastedTextTransform | undefined> {
  const textItem = dataTransfer.get('text/plain');
  if (textItem) {
    const text = await textItem.asString();
    const transformed = transformPastedText(document, text, 'markdown');
    if (transformed) {
      return transformed;
    }
  }

  const htmlItem = dataTransfer.get('text/html');
  if (htmlItem) {
    const html = await htmlItem.asString();
    const transformed = transformPastedText(document, html, 'html');
    if (transformed) {
      return transformed;
    }
  }

  return undefined;
}

export function registerNativeMarkdownImagePaste(): vscode.Disposable {
  const selector: vscode.DocumentSelector = [
    { language: 'markdown', scheme: 'file' },
    { language: 'mdx', scheme: 'file' },
  ];

  const provider: vscode.DocumentPasteEditProvider = {
    async provideDocumentPasteEdits(document, _ranges, dataTransfer) {
      const payload = await extractPastedImage(dataTransfer);
      if (payload) {
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
      }

      const transformed = await extractPastedTextTransform(document, dataTransfer);
      if (!transformed) return [];

      await vscode.workspace.fs.createDirectory(transformed.directory);
      const edit = new vscode.DocumentPasteEdit(
        transformed.text,
        transformed.title,
        MARKDOWN_IMAGE_PASTE_KIND,
      );
      const workspaceEdit = new vscode.WorkspaceEdit();
      for (const file of transformed.files) {
        workspaceEdit.createFile(file.uri, {
          contents: file.bytes,
          overwrite: false,
          ignoreIfExists: false,
        });
      }
      edit.additionalEdit = workspaceEdit;
      return [edit];
    },
  };

  return vscode.languages.registerDocumentPasteEditProvider(selector, provider, {
    providedPasteEditKinds: [MARKDOWN_IMAGE_PASTE_KIND],
    pasteMimeTypes: ['image/*', 'files', 'text/html', 'text/plain'],
  });
}
