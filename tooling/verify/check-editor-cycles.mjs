import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.join(repositoryRoot, 'packages/editor-core/src');

async function collectTypeScriptFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectTypeScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) result.push(fullPath);
  }
  return result;
}

function resolveImport(importer, specifier, files) {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

const fileList = await collectTypeScriptFiles(sourceRoot);
const files = new Set(fileList);
const graph = new Map(fileList.map((file) => [file, new Set()]));
const importPattern = /(?:from\s+|import\s*\()['"]([^'"]+)['"]/g;

for (const file of fileList) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const target = resolveImport(file, match[1], files);
    if (target) graph.get(file).add(target);
  }
}

let sequence = 0;
const indices = new Map();
const lowLinks = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];

function visit(file) {
  indices.set(file, sequence);
  lowLinks.set(file, sequence);
  sequence += 1;
  stack.push(file);
  onStack.add(file);

  for (const dependency of graph.get(file)) {
    if (!indices.has(dependency)) {
      visit(dependency);
      lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)));
    } else if (onStack.has(dependency)) {
      lowLinks.set(file, Math.min(lowLinks.get(file), indices.get(dependency)));
    }
  }

  if (lowLinks.get(file) !== indices.get(file)) return;
  const component = [];
  while (stack.length > 0) {
    const member = stack.pop();
    onStack.delete(member);
    component.push(member);
    if (member === file) break;
  }
  if (component.length > 1 || graph.get(file).has(file)) cycles.push(component);
}

for (const file of fileList) {
  if (!indices.has(file)) visit(file);
}

if (cycles.length > 0) {
  console.error('Editor module cycles detected:');
  for (const cycle of cycles) {
    console.error(cycle.map((file) => `  - ${path.relative(sourceRoot, file)}`).join('\n'));
  }
  process.exitCode = 1;
} else {
  console.log(`verified editor dependency graph: ${fileList.length} modules, no cycles`);
}
