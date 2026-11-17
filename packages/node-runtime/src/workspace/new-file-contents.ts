import * as path from 'node:path';
import { Document, Packer, Paragraph } from 'docx';
import { buildEmptyXlsxBytes } from '@easyview/ooxml-xlsx';

/** Extensions that must be created as valid OOXML packages (empty bytes fail JSZip/parse). */
const DOCX_SEED_EXTENSIONS = new Set(['.docx', '.dotx']);
const XLSX_SEED_EXTENSIONS = new Set(['.xlsx']);

let cachedDocxSeed: Promise<Buffer> | undefined;
let cachedXlsxSeed: Promise<Buffer> | undefined;

async function buildEmptyDocxSeed(): Promise<Buffer> {
  const document = new Document({
    sections: [{ children: [new Paragraph({ text: '' })] }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

async function buildEmptyXlsxSeed(): Promise<Buffer> {
  return Buffer.from(await buildEmptyXlsxBytes());
}

/**
 * Initial bytes for a newly created workspace file.
 * Office Open XML types get a minimal valid package; everything else stays empty.
 */
export async function initialContentsForNewFile(fileName: string): Promise<Buffer | string> {
  const ext = path.extname(fileName).toLowerCase();
  if (DOCX_SEED_EXTENSIONS.has(ext)) {
    return (cachedDocxSeed ??= buildEmptyDocxSeed());
  }
  if (XLSX_SEED_EXTENSIONS.has(ext)) {
    return (cachedXlsxSeed ??= buildEmptyXlsxSeed());
  }
  return '';
}

/** Test/helpers: clear seed caches between cases if needed. */
export function clearNewFileContentCaches(): void {
  cachedDocxSeed = undefined;
  cachedXlsxSeed = undefined;
}
