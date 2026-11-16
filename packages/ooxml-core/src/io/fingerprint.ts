import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function shortFingerprint(bytes: Uint8Array): string {
  return hashBytes(bytes).slice(0, 16);
}

export async function fingerprintFile(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return shortFingerprint(bytes);
}
