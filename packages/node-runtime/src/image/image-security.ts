import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const IMAGE_MIME_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
} as const;

export const ALLOWED_IMAGE_MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
} as const;

export type AllowedImageMime = keyof typeof IMAGE_MIME_TYPES;
export type CanonicalImageMime = Exclude<AllowedImageMime, "image/jpg">;
export type ImageServiceErrorCode =
  | "INVALID_IMAGE"
  | "UNSUPPORTED_MIME"
  | "IMAGE_NOT_FOUND"
  | "IMAGE_PATH_OUTSIDE_DOCUMENT"
  | "IMAGE_PATH_OUTSIDE_ASSETS"
  | "IMAGE_DOWNLOAD_FAILED"
  | "IMAGE_SELECTION_CANCELLED"
  | "IMAGE_SELECTION_UNAVAILABLE";

export class ImageServiceError extends Error {
  constructor(public readonly code: ImageServiceErrorCode, message: string) {
    super(message);
    this.name = "ImageServiceError";
  }
}

export interface SafeLocalImage {
  data: Buffer;
  mimeType: CanonicalImageMime;
  path: string;
}

export interface ParsedImageDataUrl {
  mimeType: CanonicalImageMime;
  bytes: Buffer;
}

function decodeSource(source: string): string {
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

function stripUrlDecorations(source: string): string {
  const marker = source.search(/[?#]/);
  return marker === -1 ? source : source.slice(0, marker);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function normalizeImageMimeType(value: string | null | undefined): CanonicalImageMime {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  if (!mimeType || !(mimeType in IMAGE_MIME_TYPES)) {
    throw new ImageServiceError("UNSUPPORTED_MIME", `Unsupported image MIME type: ${value || "unknown"}`);
  }
  return mimeType as CanonicalImageMime;
}

export function createImageDataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${normalizeImageMimeType(mimeType)};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function parseImageDataUrl(value: string): ParsedImageDataUrl {
  const match = value.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
  if (!match) {
    throw new ImageServiceError("INVALID_IMAGE", "Image data URL must use base64 encoding.");
  }

  const mimeType = normalizeImageMimeType(match[1]);
  const encoded = match[2].replace(/\s+/g, "");
  if (!encoded || !/^[a-z\d+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) {
    throw new ImageServiceError("INVALID_IMAGE", "Image data URL contains invalid base64 data.");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new ImageServiceError("INVALID_IMAGE", "Image data is empty or exceeds the 20 MB limit.");
  }
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime || detectedMime !== mimeType) {
    throw new ImageServiceError("INVALID_IMAGE", "Image MIME type does not match its contents.");
  }
  return { mimeType, bytes };
}

export function detectImageMime(data: Uint8Array): CanonicalImageMime | null {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6) {
    const header = String.fromCharCode(...data.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return "image/bmp";
  if (data.length >= 12
    && String.fromCharCode(...data.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...data.slice(8, 12)) === "WEBP") return "image/webp";
  const text = Buffer.from(data).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text) ? "image/svg+xml" : null;
}

export function mimeForImageExtension(fileName: string): CanonicalImageMime | null {
  return ALLOWED_IMAGE_MIME_BY_EXTENSION[
    path.extname(fileName).toLowerCase() as keyof typeof ALLOWED_IMAGE_MIME_BY_EXTENSION
  ] ?? null;
}

export function isImageMimeCompatibleWithFilename(fileName: string, mimeType: string): boolean {
  try {
    return mimeForImageExtension(fileName) === normalizeImageMimeType(mimeType);
  } catch {
    return false;
  }
}

export function validateImageFileName(fileName: string): void {
  if (!fileName || fileName === "." || fileName === ".." || /[\\/]/.test(fileName) || path.basename(fileName) !== fileName) {
    throw new Error("Invalid image filename");
  }
  if (!mimeForImageExtension(fileName)) throw new Error("Unsupported image extension");
}

export function documentDirectory(documentPath: string): string {
  if (!documentPath || !path.isAbsolute(documentPath)) {
    throw new ImageServiceError("INVALID_IMAGE", "documentPath must be an absolute Markdown file path.");
  }
  return path.dirname(path.resolve(documentPath));
}

export async function resolveLocalImagePath(
  documentPath: string,
  source: string,
  allowAuthorizedAbsolute = false,
): Promise<string> {
  const decoded = stripUrlDecorations(decodeSource(source.trim()));
  const documentDir = path.resolve(documentDirectory(documentPath));
  const realDocumentDir = await realpath(documentDir);
  const absolute = path.isAbsolute(decoded) || isWindowsAbsolutePath(decoded);
  if (!decoded) throw new ImageServiceError("INVALID_IMAGE", "Image source cannot be empty.");
  if (absolute && !allowAuthorizedAbsolute && !isPathInside(documentDir, path.resolve(decoded))) {
    throw new ImageServiceError("IMAGE_PATH_OUTSIDE_DOCUMENT", "Absolute image paths require an authorized picker and must be inside the Markdown document directory.");
  }
  if (!absolute && decoded.replaceAll("\\", "/").split("/").includes("..")) {
    throw new ImageServiceError("IMAGE_PATH_OUTSIDE_DOCUMENT", "Relative image path escapes the Markdown document directory.");
  }

  const candidate = absolute ? path.resolve(decoded) : path.resolve(documentDir, decoded);
  if (!allowAuthorizedAbsolute && !isPathInside(documentDir, candidate)) {
    throw new ImageServiceError("IMAGE_PATH_OUTSIDE_DOCUMENT", "Relative image path escapes the Markdown document directory.");
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImageServiceError("IMAGE_NOT_FOUND", `Image file does not exist: ${candidate}`);
    }
    throw error;
  }
  if (!isPathInside(realDocumentDir, resolvedPath)) {
    throw new ImageServiceError("IMAGE_PATH_OUTSIDE_DOCUMENT", "Image path resolves outside the Markdown document directory.");
  }
  return resolvedPath;
}

export async function readLocalImage(
  filePath: string,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<{ mimeType: CanonicalImageMime; bytes: Buffer }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ImageServiceError("IMAGE_NOT_FOUND", `Image file does not exist: ${filePath}`);
    }
    throw error;
  }
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new ImageServiceError("INVALID_IMAGE", "Image file is empty or exceeds the 20 MB limit.");
  }
  const extensionMime = mimeForImageExtension(filePath);
  if (!extensionMime) throw new ImageServiceError("UNSUPPORTED_MIME", `Unsupported image extension: ${path.extname(filePath) || "none"}`);
  const detectedMime = detectImageMime(bytes);
  if (!detectedMime || detectedMime !== extensionMime) {
    throw new ImageServiceError("INVALID_IMAGE", "Image extension and MIME content do not match.");
  }
  return { mimeType: detectedMime, bytes };
}

export async function readSafeLocalImage(options: {
  documentDir: string;
  source: string;
  maxBytes: number;
}): Promise<SafeLocalImage> {
  const resolvedPath = await resolveLocalImagePathFromDirectory(options.documentDir, options.source);
  const fileInfo = await stat(resolvedPath);
  if (!fileInfo.isFile()) throw new Error("Local image is not a file");
  if (fileInfo.size > options.maxBytes) throw new Error("Local image exceeds the size limit");
  const data = await readFile(resolvedPath);
  const detectedMime = detectImageMime(data);
  const extensionMime = mimeForImageExtension(resolvedPath);
  if (!detectedMime || !extensionMime || detectedMime !== extensionMime) throw new Error("Local image extension and MIME type do not match");
  return { data, mimeType: detectedMime, path: resolvedPath };
}

async function resolveLocalImagePathFromDirectory(documentDir: string, source: string): Promise<string> {
  const decoded = stripUrlDecorations(decodeSource(source.trim()));
  if (!decoded || path.isAbsolute(decoded) || isWindowsAbsolutePath(decoded)) throw new Error("Absolute local image paths are not allowed");
  if (decoded.replaceAll("\\", "/").split("/").includes("..")) throw new Error("Parent traversal in local image paths is not allowed");
  const root = await realpath(documentDir);
  const candidate = path.resolve(root, decoded);
  if (!isPathInside(root, candidate)) throw new Error("Local image path escapes the document directory");
  const resolvedPath = await realpath(candidate);
  if (!isPathInside(root, resolvedPath)) throw new Error("Symlinked local image escapes the document directory");
  return resolvedPath;
}

export function toMarkdownRelativePath(documentPath: string, imagePath: string): string {
  const relative = path.relative(documentDirectory(documentPath), path.resolve(imagePath)).replace(/\\/g, "/");
  return relative.startsWith(".") || relative.startsWith("/") ? relative : `./${relative}`;
}

export function sanitizeFileName(value: string | undefined, fallback: string): string {
  const basename = path.basename((value || "").replace(/[\\/]/g, path.sep));
  const normalized = basename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const result = normalized || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(result) ? `_${result}` : result;
}

export function sanitizeDocumentStem(documentPath: string): string {
  return sanitizeFileName(path.basename(documentPath, path.extname(documentPath)), "document");
}
