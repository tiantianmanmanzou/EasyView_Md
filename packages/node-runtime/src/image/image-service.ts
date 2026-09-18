import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  createImageDataUrl,
  documentDirectory,
  IMAGE_MIME_TYPES,
  ImageServiceError,
  isPathInside,
  parseImageDataUrl,
  readLocalImage,
  resolveLocalImagePath,
  sanitizeDocumentStem,
  sanitizeFileName,
  toMarkdownRelativePath,
} from './image-security';
import { fetchRemoteImage, IMAGE_DOWNLOAD_TIMEOUT_MS, type AddressLookup, type RemoteFetch } from './remote-image';

export type HostnameResolver = AddressLookup;
export type ImagePathSelector = () => Promise<string | null>;

export type ImageDialog = {
  showOpenDialog(options: {
    properties: string[];
    filters: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
};

export interface ReadImageOptions {
  documentPath: string;
  source: string;
  fetchImpl?: RemoteFetch;
  resolveHostname?: HostnameResolver;
  timeoutMs?: number;
}

export interface PickImageOptions extends Omit<ReadImageOptions, "source"> {
  dialog?: ImageDialog;
  selectPath?: ImagePathSelector;
}

export interface SavePastedImageOptions {
  documentPath: string;
  dataUrl: string;
  preferredName?: string;
}

export interface SelectedImage {
  sourcePath: string;
  relativePath: string;
  dataUrl: string;
}

export interface SavedImage {
  filePath: string;
  relativePath: string;
  src: string;
}

const IMAGE_FILTER_EXTENSIONS = Object.values(IMAGE_MIME_TYPES).map((extension) => extension.slice(1));

export async function readImageAsDataUrl(options: ReadImageOptions): Promise<string> {
  const source = options.source.trim();
  if (!source) throw new ImageServiceError("INVALID_IMAGE", "Image source cannot be empty.");
  if (/^data:/i.test(source)) {
    const parsed = parseImageDataUrl(source);
    return createImageDataUrl(parsed.mimeType, parsed.bytes);
  }
  if (/^https?:\/\//i.test(source)) {
    const image = await fetchRemoteImage({
      url: source,
      fetchImpl: options.fetchImpl,
      resolveHostname: options.resolveHostname,
      timeoutMs: options.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS,
    });
    return createImageDataUrl(image.mimeType, image.bytes);
  }
  if (/^[a-z]+:/i.test(source) && !path.isAbsolute(source)) {
    throw new ImageServiceError("INVALID_IMAGE", `Unsupported image source protocol: ${source.split(":", 1)[0]}`);
  }
  if (path.isAbsolute(source)) {
    throw new ImageServiceError("IMAGE_PATH_OUTSIDE_DOCUMENT", "Absolute local image paths are not allowed without an authorized picker.");
  }
  const imagePath = await resolveLocalImagePath(options.documentPath, source);
  const image = await readLocalImage(imagePath);
  return createImageDataUrl(image.mimeType, image.bytes);
}

export async function pickImage(options: PickImageOptions): Promise<SelectedImage> {
  let selectedPath: string | null = null;
  if (options.selectPath) selectedPath = await options.selectPath();
  else if (options.dialog) {
    const result = await options.dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: IMAGE_FILTER_EXTENSIONS }],
    });
    selectedPath = result.canceled ? null : result.filePaths[0] || null;
  }
  if (!selectedPath) {
    if (!options.dialog && !options.selectPath) throw new ImageServiceError("IMAGE_SELECTION_UNAVAILABLE", "An image dialog or path selector is required.");
    throw new ImageServiceError("IMAGE_SELECTION_CANCELLED", "Image selection was cancelled.");
  }
  const selectedAbsolutePath = path.resolve(selectedPath);
  const resolvedPath = await resolveLocalImagePath(options.documentPath, selectedAbsolutePath, true);
  const image = await readLocalImage(resolvedPath);
  return {
    sourcePath: selectedAbsolutePath,
    relativePath: toMarkdownRelativePath(options.documentPath, selectedAbsolutePath),
    dataUrl: createImageDataUrl(image.mimeType, image.bytes),
  };
}

export async function savePastedImage(options: SavePastedImageOptions): Promise<SavedImage> {
  const parsed = parseImageDataUrl(options.dataUrl);
  const assetsDirectory = path.join(documentDirectory(options.documentPath), `${sanitizeDocumentStem(options.documentPath)}.assets`);
  const extension = IMAGE_MIME_TYPES[parsed.mimeType];
  const requestedName = sanitizeFileName(options.preferredName, `image-${Date.now()}${extension}`);
  const requestedExtension = path.extname(requestedName).toLowerCase();
  const baseName = path.basename(requestedName, requestedExtension || undefined).replace(/[-. ]+$/g, "") || "image";
  const targetDirectory = path.resolve(assetsDirectory);
  let targetPath = path.resolve(targetDirectory, `${baseName}${extension}`);
  if (!isPathInside(targetDirectory, targetPath)) throw new ImageServiceError("IMAGE_PATH_OUTSIDE_ASSETS", "Image filename escapes the document assets directory.");
  await mkdir(targetDirectory, { recursive: true });
  for (let index = 1; ; index += 1) {
    try {
      await writeFile(targetPath, parsed.bytes, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      targetPath = path.join(targetDirectory, `${baseName}-${index}${extension}`);
    }
  }
  const relativePath = toMarkdownRelativePath(options.documentPath, targetPath);
  return { filePath: targetPath, relativePath, src: relativePath };
}

export { ImageServiceError };
