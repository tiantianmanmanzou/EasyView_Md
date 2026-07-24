import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PNG } from 'pngjs';

type CommandError = Error & { code?: string | number; stderr?: string };

function sanitizeBaseName(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'document';
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 20 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const commandError = error as CommandError;
      commandError.stderr = stderr;
      reject(commandError);
    });
  });
}

async function findConvertedDocx(directory: string, stem: string): Promise<string> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const expected = `${stem}.docx`.toLocaleLowerCase();
  const output = entries.find((entry) => entry.isFile() && entry.name.toLocaleLowerCase() === expected)
    ?? entries.find((entry) => entry.isFile() && path.extname(entry.name).toLocaleLowerCase() === '.docx');
  if (!output) {
    throw new Error('LibreOffice did not produce a DOCX file.');
  }
  return path.join(directory, output.name);
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath);
      return entry.isFile() ? [fullPath] : [];
    }));
    return files.flat();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (entity, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
    const entities: Record<string, string> = {
      amp: '&', apos: "'", gt: '>', lt: '<', quot: '"',
    };
    return entities[named.toLowerCase()] ?? entity;
  });
}

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function getImageDimensions(tag: string): string {
  const dimensions: string[] = [];
  const style = getHtmlAttribute(tag, 'style') ?? '';
  const styleDimensions = new Map<string, string>();
  for (const match of style.matchAll(/(?:^|;)\s*(width|height)\s*:\s*([^;]+)/gi)) {
    styleDimensions.set(match[1].toLowerCase(), match[2].trim());
  }

  for (const name of ['width', 'height']) {
    const value = styleDimensions.get(name) ?? getHtmlAttribute(tag, name);
    // Only keep a single CSS size token; this is compatible with the editor's image attributes.
    if (value && /^\d+(?:\.\d+)?(?:px|pt|pc|in|cm|mm|em|rem|%|vw|vh)?$/i.test(value)) {
      dimensions.push(`${name}=${value}`);
    }
  }
  return dimensions.length ? `{${dimensions.join(' ')}}` : '';
}

function toMarkdownImage(tag: string): string {
  const src = getHtmlAttribute(tag, 'src');
  if (!src) return tag;

  const alt = decodeHtmlEntities(getHtmlAttribute(tag, 'alt') ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\\[\]])/g, '\\$1');
  const url = decodeHtmlEntities(src).trim();
  const formattedUrl = /[\s()]/.test(url) ? `<${url}>` : url;
  return `![${alt}](${formattedUrl})${getImageDimensions(tag)}`;
}

/**
 * Replace Pandoc's temporary media paths and convert HTML images to the editor's
 * native image syntax. Pandoc emits HTML whenever a Word image has dimensions,
 * which otherwise becomes an unsupported HTML block in the visual editor.
 */
export function rewriteExtractedMediaPaths(markdown: string, tempMediaDirectory: string, assetDirectoryName: string): string {
  const absolutePath = tempMediaDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  const portablePath = `./${assetDirectoryName}`;
  const rewrittenPaths = markdown
    .replaceAll(`file://${absolutePath}`, portablePath)
    .replaceAll(absolutePath, portablePath);
  return rewrittenPaths.replace(/<img\b[^>]*>/gi, toMarkdownImage);
}

/**
 * Word commonly stores screenshots as transparent PNGs. Blend their alpha
 * channel against white so the Markdown image has the expected opaque page background.
 */
export function flattenPngWithWhiteBackground(input: Buffer): Buffer {
  const image = PNG.sync.read(input);
  let hasTransparency = false;

  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = image.data[offset + 3];
    if (alpha === 255) continue;

    hasTransparency = true;
    image.data[offset] = Math.round((image.data[offset] * alpha + 255 * (255 - alpha)) / 255);
    image.data[offset + 1] = Math.round((image.data[offset + 1] * alpha + 255 * (255 - alpha)) / 255);
    image.data[offset + 2] = Math.round((image.data[offset + 2] * alpha + 255 * (255 - alpha)) / 255);
    image.data[offset + 3] = 255;
  }

  // colorType 2 writes RGB rather than RGBA, so the extracted file has no alpha channel.
  return hasTransparency ? PNG.sync.write(image, { colorType: 2 }) : input;
}

async function moveExtractedMedia(
  tempMediaDirectory: string,
  targetDirectory: string,
): Promise<void> {
  const files = await listFiles(tempMediaDirectory);
  if (files.length === 0) return;

  await fs.mkdir(targetDirectory, { recursive: true });
  for (const source of files) {
    const relative = path.relative(tempMediaDirectory, source);
    const destination = path.join(targetDirectory, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (path.extname(source).toLocaleLowerCase() !== '.png') {
      await fs.copyFile(source, destination);
      continue;
    }

    try {
      const image = await fs.readFile(source);
      await fs.writeFile(destination, flattenPngWithWhiteBackground(image));
    } catch {
      // Preserve a valid conversion when an uncommon or malformed PNG cannot be decoded.
      await fs.copyFile(source, destination);
    }
  }
}

async function convertLegacyDocToDocx(inputPath: string, tempDirectory: string): Promise<string> {
  await execFileAsync('soffice', [
    '--headless',
    '--convert-to', 'docx',
    '--outdir', tempDirectory,
    inputPath,
  ]);
  return findConvertedDocx(tempDirectory, path.basename(inputPath, path.extname(inputPath)));
}

async function convertWordFile(sourceUri: vscode.Uri): Promise<vscode.Uri> {
  const sourcePath = sourceUri.fsPath;
  const extension = path.extname(sourcePath).toLocaleLowerCase();
  if (extension !== '.docx' && extension !== '.doc') {
    throw new Error('Only DOCX and DOC files can be converted.');
  }

  const documentDirectory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const safeStem = sanitizeBaseName(stem);
  const outputPath = path.join(documentDirectory, `${stem}.md`);
  const outputUri = vscode.Uri.file(outputPath);
  const assetDirectoryName = `${safeStem}.assets`;
  const assetDirectory = path.join(documentDirectory, assetDirectoryName);

  try {
    await fs.access(outputPath);
    const selection = await vscode.window.showWarningMessage(
      `${path.basename(outputPath)} already exists. Replace it?`,
      { modal: true },
      'Replace',
    );
    if (selection !== 'Replace') {
      throw new Error('Conversion cancelled.');
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      if (error?.message === 'Conversion cancelled.') throw error;
    }
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-word-'));
  try {
    const inputForPandoc = extension === '.doc'
      ? await convertLegacyDocToDocx(sourcePath, tempDirectory)
      : sourcePath;
    const tempMarkdownPath = path.join(tempDirectory, `${safeStem}.md`);
    const tempExtractDirectory = path.join(tempDirectory, 'media');
    const tempMediaDirectory = path.join(tempExtractDirectory, 'media');

    await execFileAsync('pandoc', [
      inputForPandoc,
      '--from=docx',
      '--to=gfm+pipe_tables',
      '--wrap=none',
      `--extract-media=${tempExtractDirectory}`,
      `--output=${tempMarkdownPath}`,
    ]);

    const converted = await fs.readFile(tempMarkdownPath, 'utf8');
    const markdown = rewriteExtractedMediaPaths(converted, tempMediaDirectory, assetDirectoryName);
    await moveExtractedMedia(tempMediaDirectory, assetDirectory);
    await fs.writeFile(outputPath, markdown, 'utf8');
    return outputUri;
  } catch (error) {
    const commandError = error as CommandError;
    if (commandError.code === 'ENOENT') {
      const executable = commandError.message.includes('soffice') ? 'LibreOffice (soffice)' : 'Pandoc';
      throw new Error(`${executable} is required to convert Word documents but was not found.`);
    }
    throw error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

export function registerWordToMarkdownCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('inlineMd.convertWordToMarkdown', async (uri?: vscode.Uri) => {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || targetUri.scheme !== 'file') {
      vscode.window.showErrorMessage('Select a DOCX or DOC file first.');
      return;
    }

    try {
      const outputUri = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Converting Word document to Markdown',
          cancellable: false,
        },
        () => convertWordFile(targetUri),
      );
      const selection = await vscode.window.showInformationMessage(
        `Converted to ${path.basename(outputUri.fsPath)}`,
        'Open Markdown',
      );
      if (selection === 'Open Markdown') {
        await vscode.commands.executeCommand('vscode.openWith', outputUri, 'inlineMd.markdownEditor');
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      if (message === 'Conversion cancelled.') return;
      vscode.window.showErrorMessage(`Word to Markdown conversion failed: ${message}`);
    }
  });
}
