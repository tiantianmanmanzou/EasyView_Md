import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, copyFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { writeFileAtomically } from '../filesystem/file-write';
import { stripPandocHighlightMarkup } from "@easyview/markdown-core/pandoc-highlight-markup";

type CommandError = Error & { code?: string | number; stderr?: string };
const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;

export type DocumentConversionErrorCode =
  | "INVALID_ARGUMENT"
  | "OUTPUT_EXISTS"
  | "DEPENDENCY_MISSING"
  | "CONVERSION_FAILED";

export class DocumentConversionError extends Error {
  readonly code: DocumentConversionErrorCode;
  readonly command?: string;

  constructor(code: DocumentConversionErrorCode, message: string, command?: string) {
    super(message);
    this.name = "DocumentConversionError";
    this.code = code;
    this.command = command;
  }
}

export interface DocumentConversionRequest {
  sourcePath: string;
  overwrite: boolean;
}

export interface DocumentConversionResult {
  sourcePath: string;
  outputPath: string;
  assetDirectory: string;
  assetPaths: string[];
  markdown: string;
}

function sanitizeBaseName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "document";
}

function validateRequest(request: DocumentConversionRequest): string {
  if (!request || typeof request.sourcePath !== "string" || request.sourcePath.trim() === "") {
    throw new DocumentConversionError("INVALID_ARGUMENT", "sourcePath must be a non-empty path.");
  }
  if (typeof request.overwrite !== "boolean") {
    throw new DocumentConversionError("INVALID_ARGUMENT", "overwrite must be a boolean.");
  }
  return path.resolve(request.sourcePath);
}

async function ensureSourceFile(sourcePath: string, extensions: string[]): Promise<void> {
  let info;
  try {
    info = await stat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DocumentConversionError("INVALID_ARGUMENT", `Source file was not found: ${sourcePath}`);
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new DocumentConversionError("INVALID_ARGUMENT", `Source path is not a file: ${sourcePath}`);
  }
  if (!extensions.includes(path.extname(sourcePath).toLowerCase())) {
    throw new DocumentConversionError(
      "INVALID_ARGUMENT",
      `Unsupported source format. Expected ${extensions.join(" or ")}.`,
    );
  }
}

async function ensureOutputAvailable(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    await stat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!overwrite) {
    throw new DocumentConversionError(
      "OUTPUT_EXISTS",
      `Output file already exists: ${outputPath}. Set overwrite=true to replace it.`,
    );
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(command, args, { maxBuffer: MAX_BUFFER });
  } catch (error) {
    const commandError = error as CommandError;
    if (commandError.code === "ENOENT") {
      throw new DocumentConversionError(
        "DEPENDENCY_MISSING",
        `${command} is required for document conversion but was not found.`,
        command,
      );
    }
    const detail = commandError.stderr?.trim();
    throw new DocumentConversionError(
      "CONVERSION_FAILED",
      detail ? `${command} failed: ${detail}` : `${command} failed.`,
      command,
    );
  }
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(filePath);
      return entry.isFile() ? [filePath] : [];
    }));
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (entity, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
    const entities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
    return entities[named.toLowerCase()] ?? entity;
  });
}

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function getImageDimensions(tag: string): string {
  const dimensions: string[] = [];
  const style = getHtmlAttribute(tag, "style") ?? "";
  const styleDimensions = new Map<string, string>();
  for (const match of style.matchAll(/(?:^|;)\s*(width|height)\s*:\s*([^;]+)/gi)) {
    styleDimensions.set(match[1].toLowerCase(), match[2].trim());
  }
  for (const name of ["width", "height"]) {
    const value = styleDimensions.get(name) ?? getHtmlAttribute(tag, name);
    if (value && /^\d+(?:\.\d+)?(?:px|pt|pc|in|cm|mm|em|rem|%|vw|vh)?$/i.test(value)) {
      dimensions.push(`${name}=${value}`);
    }
  }
  return dimensions.length ? `{${dimensions.join(" ")}}` : "";
}

function toMarkdownImage(tag: string): string {
  const src = getHtmlAttribute(tag, "src");
  if (!src) return tag;
  const alt = decodeHtmlEntities(getHtmlAttribute(tag, "alt") ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\\[\]])/g, "\\$1");
  const url = decodeHtmlEntities(src).trim();
  const formattedUrl = /[\s()]/.test(url) ? `<${url}>` : url;
  return `![${alt}](${formattedUrl})${getImageDimensions(tag)}`;
}

export function rewriteExtractedMediaPaths(
  markdown: string,
  tempMediaDirectory: string,
  assetDirectoryName: string,
): string {
  const absolutePath = tempMediaDirectory.replace(/\\/g, "/").replace(/\/$/, "");
  const portablePath = `./${assetDirectoryName}`;
  const rewrittenPaths = markdown
    .replaceAll(`file://${absolutePath}`, portablePath)
    .replaceAll(absolutePath, portablePath);
  return rewrittenPaths.replace(/<img\b[^>]*>/gi, toMarkdownImage);
}

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
  return hasTransparency ? PNG.sync.write(image, { colorType: 2 }) : input;
}

async function copyExtractedMedia(sourceDirectory: string, targetDirectory: string): Promise<string[]> {
  const files = await listFiles(sourceDirectory);
  if (files.length === 0) return [];
  await mkdir(targetDirectory, { recursive: true });
  const copied: string[] = [];
  for (const source of files) {
    const relative = path.relative(sourceDirectory, source);
    const destination = path.join(targetDirectory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (path.extname(source).toLowerCase() === ".png") {
      try {
        await writeFile(destination, flattenPngWithWhiteBackground(await readFile(source)));
      } catch {
        await copyFile(source, destination);
      }
    } else {
      await copyFile(source, destination);
    }
    copied.push(destination);
  }
  return copied;
}

async function findConvertedDocx(directory: string, stem: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const expected = `${stem}.docx`.toLowerCase();
  const output = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === expected)
    ?? entries.find((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".docx");
  if (!output) throw new DocumentConversionError("CONVERSION_FAILED", "LibreOffice did not produce a DOCX file.");
  return path.join(directory, output.name);
}

async function convertLegacyDocToDocx(inputPath: string, tempDirectory: string): Promise<string> {
  await runCommand("soffice", ["--headless", "--convert-to", "docx", "--outdir", tempDirectory, inputPath]);
  return findConvertedDocx(tempDirectory, path.basename(inputPath, path.extname(inputPath)));
}

export async function convertWordToMarkdown(request: DocumentConversionRequest): Promise<DocumentConversionResult> {
  const sourcePath = validateRequest(request);
  await ensureSourceFile(sourcePath, [".doc", ".docx"]);
  const directory = path.dirname(sourcePath);
  const extension = path.extname(sourcePath).toLowerCase();
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const safeStem = sanitizeBaseName(stem);
  const outputPath = path.join(directory, `${stem}.md`);
  const assetDirectory = path.join(directory, `${safeStem}.assets`);
  await ensureOutputAvailable(outputPath, request.overwrite);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "easyview-word-"));
  try {
    const inputForPandoc = extension === ".doc"
      ? await convertLegacyDocToDocx(sourcePath, temporaryDirectory)
      : sourcePath;
    const temporaryMarkdownPath = path.join(temporaryDirectory, `${safeStem}.md`);
    const temporaryExtractDirectory = path.join(temporaryDirectory, "media");
    const temporaryMediaDirectory = path.join(temporaryExtractDirectory, "media");
    await runCommand("pandoc", [
      inputForPandoc,
      "--from=docx",
      "--to=gfm+pipe_tables",
      "--wrap=none",
      `--extract-media=${temporaryExtractDirectory}`,
      `--output=${temporaryMarkdownPath}`,
    ]);

    const converted = await readFile(temporaryMarkdownPath, "utf8");
    const markdown = stripPandocHighlightMarkup(
      rewriteExtractedMediaPaths(converted, temporaryMediaDirectory, `${safeStem}.assets`),
    );
    if (request.overwrite) await rm(assetDirectory, { recursive: true, force: true });
    const assetPaths = await copyExtractedMedia(temporaryMediaDirectory, assetDirectory);
    await writeFileAtomically(outputPath, markdown);
    return { sourcePath, outputPath, assetDirectory, assetPaths, markdown };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function pdfTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u000c/g, "\n\n---\n\n")
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markdownImageReferences(assetDirectoryName: string, filePaths: string[]): string {
  return filePaths
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((filePath) => `![](./${assetDirectoryName}/${path.basename(filePath)})`)
    .join("\n\n");
}

export async function convertPdfToMarkdown(request: DocumentConversionRequest): Promise<DocumentConversionResult> {
  const sourcePath = validateRequest(request);
  await ensureSourceFile(sourcePath, [".pdf"]);
  const directory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const safeStem = sanitizeBaseName(stem);
  const outputPath = path.join(directory, `${stem}.md`);
  const assetDirectory = path.join(directory, `${safeStem}.assets`);
  await ensureOutputAvailable(outputPath, request.overwrite);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "easyview-pdf-"));
  try {
    const textPath = path.join(temporaryDirectory, "document.txt");
    const extractedImageDirectory = path.join(temporaryDirectory, "images");
    const extractedImagePrefix = path.join(extractedImageDirectory, "image");
    await mkdir(extractedImageDirectory, { recursive: true });
    await runCommand("pdftotext", ["-layout", sourcePath, textPath]);
    await runCommand("pdfimages", ["-png", sourcePath, extractedImagePrefix]);
    const text = pdfTextToMarkdown(await readFile(textPath, "utf8"));

    if (request.overwrite) await rm(assetDirectory, { recursive: true, force: true });
    let assetPaths = await copyExtractedMedia(extractedImageDirectory, assetDirectory);
    let markdown = text;
    if (!markdown) {
      const pagesDirectory = path.join(temporaryDirectory, "pages");
      const pagePrefix = path.join(pagesDirectory, "page");
      await mkdir(pagesDirectory, { recursive: true });
      await runCommand("pdftoppm", ["-png", "-r", "150", sourcePath, pagePrefix]);
      assetPaths = await copyExtractedMedia(pagesDirectory, assetDirectory);
      markdown = markdownImageReferences(`${safeStem}.assets`, assetPaths);
    } else if (assetPaths.length > 0) {
      markdown = `${markdown}\n\n${markdownImageReferences(`${safeStem}.assets`, assetPaths)}`;
    }
    if (!markdown) {
      throw new DocumentConversionError("CONVERSION_FAILED", "No extractable text or page images were found in this PDF.");
    }
    const outputMarkdown = `${markdown}\n`;
    await writeFileAtomically(outputPath, outputMarkdown);
    return { sourcePath, outputPath, assetDirectory, assetPaths, markdown: outputMarkdown };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function convertDocumentToMarkdown(
  request: DocumentConversionRequest,
): Promise<DocumentConversionResult> {
  const sourcePath = validateRequest(request);
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === ".doc" || extension === ".docx") return convertWordToMarkdown(request);
  if (extension === ".pdf") return convertPdfToMarkdown(request);
  throw new DocumentConversionError("INVALID_ARGUMENT", "Only DOC, DOCX, and PDF files can be converted.");
}
