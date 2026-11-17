import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Include the vendored Word engine's license and source notice in distributable builds. */
export async function copyDocxLicenses(workspaceDir, distDir) {
  for (const name of ['core', 'react', 'i18n', 'agents']) {
    const source = path.join(workspaceDir, 'packages', `docx-${name}`);
    const target = path.join(distDir, 'licenses', `docx-${name}`);
    await mkdir(target, { recursive: true });
    await Promise.all(['LICENSE', 'NOTICE'].map((file) => cp(path.join(source, file), path.join(target, file))));
  }
}
