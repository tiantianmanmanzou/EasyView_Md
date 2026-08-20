import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { flattenPngWithWhiteBackground } from './wordToMarkdown';

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

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(filePath);
      return entry.isFile() ? [filePath] : [];
    }));
    return nested.flat();
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Keep extracted PDF text editable without inventing a heading/table hierarchy. */
export function pdfTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u000c/g, '\n\n---\n\n')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function markdownImageReferences(assetDirectoryName: string, filePaths: string[]): string {
  return filePaths
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((filePath) => `![](./${assetDirectoryName}/${path.basename(filePath)})`)
    .join('\n\n');
}

async function copyImagesWithWhiteBackground(sourceDirectory: string, assetDirectory: string): Promise<string[]> {
  const files = await listFiles(sourceDirectory);
  if (files.length === 0) return [];

  await fs.mkdir(assetDirectory, { recursive: true });
  const copied: string[] = [];
  for (const source of files) {
    const destination = path.join(assetDirectory, path.basename(source));
    if (path.extname(source).toLowerCase() !== '.png') {
      await fs.copyFile(source, destination);
    } else {
      try {
        await fs.writeFile(destination, flattenPngWithWhiteBackground(await fs.readFile(source)));
      } catch {
        await fs.copyFile(source, destination);
      }
    }
    copied.push(destination);
  }
  return copied;
}

async function ensureReplaceAllowed(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const selection = await vscode.window.showWarningMessage(
    `${path.basename(outputPath)} already exists. Replace it?`,
    { modal: true },
    'Replace',
  );
  if (selection !== 'Replace') throw new Error('Conversion cancelled.');
}

async function convertPdfFile(sourceUri: vscode.Uri): Promise<vscode.Uri> {
  const sourcePath = sourceUri.fsPath;
  if (path.extname(sourcePath).toLowerCase() !== '.pdf') {
    throw new Error('Only PDF files can be converted.');
  }

  const documentDirectory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const safeStem = sanitizeBaseName(stem);
  const outputPath = path.join(documentDirectory, `${stem}.md`);
  const outputUri = vscode.Uri.file(outputPath);
  const assetDirectoryName = `${safeStem}.assets`;
  const assetDirectory = path.join(documentDirectory, assetDirectoryName);
  await ensureReplaceAllowed(outputPath);

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-pdf-'));
  try {
    const textPath = path.join(tempDirectory, 'document.txt');
    const extractedImageDirectory = path.join(tempDirectory, 'images');
    const extractedImagePrefix = path.join(extractedImageDirectory, 'image');
    await fs.mkdir(extractedImageDirectory, { recursive: true });

    await execFileAsync('pdftotext', ['-layout', sourcePath, textPath]);
    await execFileAsync('pdfimages', ['-png', sourcePath, extractedImagePrefix]);
    const text = pdfTextToMarkdown(await fs.readFile(textPath, 'utf8'));

    // Reset managed assets on replacement so the Markdown cannot retain stale PDF images.
    await fs.rm(assetDirectory, { recursive: true, force: true });
    let imagePaths = await copyImagesWithWhiteBackground(extractedImageDirectory, assetDirectory);
    let markdown = text;

    if (!markdown) {
      const pagesDirectory = path.join(tempDirectory, 'pages');
      const pagePrefix = path.join(pagesDirectory, 'page');
      await fs.mkdir(pagesDirectory, { recursive: true });
      await execFileAsync('pdftoppm', ['-png', '-r', '150', sourcePath, pagePrefix]);
      imagePaths = await copyImagesWithWhiteBackground(pagesDirectory, assetDirectory);
      markdown = markdownImageReferences(assetDirectoryName, imagePaths);
    } else if (imagePaths.length > 0) {
      markdown = `${markdown}\n\n${markdownImageReferences(assetDirectoryName, imagePaths)}`;
    }

    if (!markdown) {
      throw new Error('No extractable text or page images were found in this PDF.');
    }
    await fs.writeFile(outputPath, `${markdown}\n`, 'utf8');
    return outputUri;
  } catch (error) {
    const commandError = error as CommandError;
    if (commandError.code === 'ENOENT') {
      throw new Error('Poppler is required to convert PDF files but was not found.');
    }
    throw error;
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

export function registerPdfToMarkdownCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('inlineMd.convertPdfToMarkdown', async (uri?: vscode.Uri) => {
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri || targetUri.scheme !== 'file') {
      vscode.window.showErrorMessage('Select a PDF file first.');
      return;
    }

    try {
      const outputUri = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Converting PDF to Markdown',
          cancellable: false,
        },
        () => convertPdfFile(targetUri),
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
      vscode.window.showErrorMessage(`PDF to Markdown conversion failed: ${message}`);
    }
  });
}
