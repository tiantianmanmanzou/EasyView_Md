import { mkdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { downloadRemoteImage } from '../image/remote-image';
import {
  detectImageMime,
  isImageMimeCompatibleWithFilename,
  readSafeLocalImage,
  validateImageFileName,
} from '../image/image-security';
import { replaceDirectoryAtomically, writeFileAtomically } from '../filesystem/file-write';

export interface HtmlExportImage {
  originalSrc: string;
  exportFilename: string;
  isExternal: boolean;
}

export interface HtmlExportRequest {
  targetPath: string;
  documentDir: string;
  html: string;
  images: HtmlExportImage[];
}

export interface HtmlExportResult {
  htmlPath: string;
  exportDir: string | null;
  imagesDir: string | null;
  failedImages: string[];
}

function validateExportFilename(exportFilename: string, imagesDir: string): string {
  validateImageFileName(exportFilename);
  const destination = path.resolve(imagesDir, exportFilename);
  const relative = path.relative(path.resolve(imagesDir), destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Export image path escapes the images directory");
  }
  return destination;
}

function getExportPaths(targetPath: string): {
  htmlPath: string;
  exportDir: string;
  imagesDir: string;
} {
  const htmlFilename = path.basename(targetPath);
  const folderName = path.basename(targetPath, path.extname(targetPath));
  const exportDir = path.join(path.dirname(targetPath), folderName);
  return {
    htmlPath: path.join(exportDir, htmlFilename),
    exportDir,
    imagesDir: path.join(exportDir, "images"),
  };
}

/**
 * Writes HTML using the same layout convention as the existing VS Code host:
 * without images the requested target is written directly; with images the
 * HTML is placed in a sibling folder with an images subdirectory.
 */
export async function writeHtmlExport(
  request: HtmlExportRequest,
): Promise<HtmlExportResult> {
  const { targetPath, documentDir, html, images } = request;
  if (!targetPath) throw new TypeError("targetPath must be a non-empty path");
  if (!documentDir) throw new TypeError("documentDir must be a non-empty path");

  if (images.length === 0) {
    await writeFileAtomically(targetPath, html);
    return { htmlPath: targetPath, exportDir: null, imagesDir: null, failedImages: [] };
  }

  const paths = getExportPaths(targetPath);
  const temporaryDir = `${paths.exportDir}.${randomUUID()}.tmp`;
  const temporaryImagesDir = path.join(temporaryDir, "images");
  await mkdir(temporaryImagesDir, { recursive: true });
  const failedImages: string[] = [];
  try {
    await writeFileAtomically(path.join(temporaryDir, path.basename(paths.htmlPath)), html);
    for (const image of images) {
      try {
        const destination = validateExportFilename(image.exportFilename, temporaryImagesDir);
        const localImage = image.isExternal
          ? null
          : await readSafeLocalImage({
              documentDir,
              source: image.originalSrc,
              maxBytes: 20 * 1024 * 1024,
            });
        const data = localImage?.data ?? await downloadRemoteImage(image.originalSrc);
        const mimeType = localImage?.mimeType ?? detectImageMime(data);
        if (!mimeType || !isImageMimeCompatibleWithFilename(image.exportFilename, mimeType)) {
          throw new Error("Image MIME type does not match the export filename");
        }
        await writeFileAtomically(destination, data);
      } catch {
        failedImages.push(image.originalSrc);
      }
    }
    await replaceDirectoryAtomically(paths.exportDir, temporaryDir);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    htmlPath: paths.htmlPath,
    exportDir: paths.exportDir,
    imagesDir: paths.imagesDir,
    failedImages,
  };
}

export const writeHtmlFile = writeHtmlExport;

export async function readExportedHtml(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}
