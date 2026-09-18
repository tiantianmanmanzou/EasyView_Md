import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomically } from '../filesystem/file-write';

export interface PdfBase64WriteRequest {
  targetPath: string;
  data: string;
}

export interface PdfBase64WriteResult {
  filePath: string;
  byteLength: number;
}

/** Writes a PDF represented by a base64 payload to the caller-provided path. */
export async function writePdfBase64(
  request: PdfBase64WriteRequest,
): Promise<PdfBase64WriteResult> {
  if (!request.targetPath)
    throw new TypeError("targetPath must be a non-empty path");
  if (!request.data)
    throw new TypeError("data must be a non-empty base64 string");

  const buffer = Buffer.from(request.data, "base64");
  if (buffer.length === 0)
    throw new TypeError("data must contain valid base64 content");

  await mkdir(path.dirname(request.targetPath), { recursive: true });
  await writeFileAtomically(request.targetPath, buffer);
  return { filePath: request.targetPath, byteLength: buffer.length };
}

export const writePdfBase64File = writePdfBase64;
