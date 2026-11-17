import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Write bytes via temp file + rename. */
export async function writeFileAtomically(filePath: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  const temp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, data);
  await rename(temp, filePath);
}
