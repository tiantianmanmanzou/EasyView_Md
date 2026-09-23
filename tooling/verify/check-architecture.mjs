import { builtinModules } from 'node:module';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

async function sourceFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (/\.(?:ts|js)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|js)$/.test(entry.name)) files.push(fullPath);
    }
  }
  await walk(path.join(root, directory));
  return files;
}

function importsOf(source) {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

const violations = [];
async function requirePath(relativePath) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    violations.push(`required architecture path is missing: ${relativePath}`);
  }
}
async function forbidImports(directory, isForbidden, reason) {
  for (const file of await sourceFiles(directory)) {
    for (const specifier of importsOf(await readFile(file, 'utf8'))) {
      if (isForbidden(specifier)) {
        violations.push(`${path.relative(root, file)} imports ${specifier}: ${reason}`);
      }
    }
  }
}

await forbidImports('packages/editor-core/src', (specifier) =>
  specifier === 'vscode'
  || specifier === 'electron'
  || specifier === '@easyview/node-runtime'
  || specifier.startsWith('apps/')
  || (nodeBuiltins.has(specifier) && specifier !== 'buffer'),
'editor-core must remain browser-only');
await forbidImports('packages/contracts/src', (specifier) =>
  specifier === 'vscode'
  || specifier === 'electron'
  || specifier.startsWith('@easyview/editor-core')
  || specifier.startsWith('@easyview/node-runtime')
  || specifier.startsWith('apps/'),
'contracts must contain platform-neutral interfaces only');
await forbidImports('packages/editor-sync', (specifier) =>
  specifier === 'vscode'
  || specifier === 'electron'
  || specifier.startsWith('@easyview/editor-core')
  || specifier.startsWith('@easyview/node-runtime')
  || specifier.startsWith('apps/')
  || nodeBuiltins.has(specifier),
'editor-sync must remain platform-neutral');
await forbidImports('packages/markdown-core/src', (specifier) =>
  specifier === 'vscode'
  || specifier === 'electron'
  || specifier.startsWith('@easyview/editor-core')
  || specifier.startsWith('@easyview/node-runtime')
  || specifier.startsWith('apps/')
  || nodeBuiltins.has(specifier),
'markdown-core must remain platform-neutral');
await forbidImports('packages/preview-ui/src', (specifier) =>
  specifier === 'vscode'
  || specifier === 'electron'
  || specifier.startsWith('@easyview/editor-core')
  || specifier.startsWith('@easyview/node-runtime')
  || specifier.startsWith('apps/'),
'preview-ui must remain host-agnostic');
await forbidImports('packages/node-runtime/src', (specifier) =>
  specifier === 'vscode'
  || specifier === 'electron'
  || specifier.startsWith('@easyview/editor-core')
  || specifier.startsWith('apps/'),
'node-runtime must not depend on UI products');

const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const key of ['main', 'publisher', 'engines', 'activationEvents', 'contributes', 'dependencies']) {
  if (key in rootPackage) violations.push(`root package.json must not contain product field: ${key}`);
}
for (const required of [
  'tsconfig.base.json',
  'resources/brand',
  'resources/demo',
  'resources/editor/fonts',
  'resources/editor/styles',
  'apps/vscode-extension/.vscode-test.mjs',
  'apps/vscode-extension/src/adapters/vscode',
  'apps/vscode-extension/src/application/document',
  'apps/vscode-extension/src/application/export',
  'apps/vscode-extension/src/application/git',
  'apps/vscode-extension/src/application/terminal',
  'apps/vscode-extension/src/entry',
  'apps/vscode-extension/src/native-editor',
  'apps/desktop/src/main',
  'apps/desktop/src/main/entry',
  'apps/desktop/src/main/application',
  'apps/desktop/src/main/adapters/electron',
  'apps/desktop/src/preload',
  'apps/desktop/src/renderer',
  'apps/desktop/src/contracts',
  'packages/contracts/src/capabilities',
  'packages/contracts/src/editor-host',
  'packages/contracts/src/export',
  'packages/contracts/src/messages',
  'packages/contracts/src/results',
  'packages/contracts/src/validation',
  'packages/editor-sync',
  'packages/contracts/src/preview',
  'packages/preview-ui/src',
  'packages/markdown-core/src/transforms',
  'packages/node-runtime/src/conversion',
  'packages/node-runtime/src/export',
  'packages/node-runtime/src/filesystem',
  'packages/node-runtime/src/git',
  'packages/node-runtime/src/image',
  'packages/node-runtime/src/terminal',
  'tests/e2e/editor',
  'tests/e2e/vscode-extension',
  'tests/e2e/desktop',
  'tests/fixtures/editor',
]) await requirePath(required);
for (const obsolete of ['src/host', 'e2e', 'test', 'esbuild.mjs', '.vscodeignore', '.vscode-test.mjs', 'assets', 'media']) {
  try {
    await readFile(path.join(root, obsolete));
    violations.push(`obsolete root product path still exists: ${obsolete}`);
  } catch (error) {
    if (error?.code === 'EISDIR') violations.push(`obsolete root product path still exists: ${obsolete}`);
    else if (error?.code !== 'ENOENT') throw error;
  }
}
for (const obsolete of ['packages/shared', 'packages/node-services', 'apps/vscode-extension/src/host', 'apps/vscode-extension/src/native', 'apps/vscode-extension/src/extension']) {
  try {
    await access(path.join(root, obsolete));
    violations.push(`obsolete architecture path still exists: ${obsolete}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

if (violations.length > 0) {
  throw new Error(`Architecture boundary violations:\n${violations.map((item) => `- ${item}`).join('\n')}`);
}
console.log('verified monorepo architecture boundaries');
