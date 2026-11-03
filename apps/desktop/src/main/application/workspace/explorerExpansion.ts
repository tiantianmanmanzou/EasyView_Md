import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomically } from '@easyview/node-runtime';

const MAX_REMEMBERED_ROOTS = 50;

/** Expanded tree folders per workspace root, shared across windows so reopening a folder restores its tree. */
export class ExplorerExpansionStore {
  private readonly filePath: string;
  private byRoot = new Map<string, string[]>();
  private loaded: Promise<void> | undefined;

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'explorer-expansion.json');
  }

  load(): Promise<void> {
    this.loaded ??= fs.readFile(this.filePath, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        for (const [rootPath, paths] of Object.entries(parsed)) {
          if (path.isAbsolute(rootPath) && Array.isArray(paths)) {
            this.byRoot.set(rootPath, paths.filter((value): value is string => typeof value === 'string'));
          }
        }
      })
      .catch(() => { this.byRoot = new Map(); });
    return this.loaded;
  }

  async get(rootPath: string): Promise<string[]> {
    await this.load();
    return [...(this.byRoot.get(rootPath) ?? [])];
  }

  async remember(rootPath: string, expandedRelativePaths: readonly string[]): Promise<void> {
    await this.load();
    const previous = this.byRoot.get(rootPath);
    if (previous && previous.length === expandedRelativePaths.length && previous.every((value, index) => value === expandedRelativePaths[index])) return;
    this.byRoot.delete(rootPath);
    this.byRoot.set(rootPath, [...expandedRelativePaths]);
    while (this.byRoot.size > MAX_REMEMBERED_ROOTS) this.byRoot.delete(this.byRoot.keys().next().value!);
    await writeFileAtomically(this.filePath, JSON.stringify(Object.fromEntries(this.byRoot), null, 2));
  }
}

let sharedStore: ExplorerExpansionStore | undefined;

export function initExplorerExpansionStore(userDataPath: string): ExplorerExpansionStore {
  sharedStore = new ExplorerExpansionStore(userDataPath);
  return sharedStore;
}

export function explorerExpansionStore(): ExplorerExpansionStore {
  if (!sharedStore) throw new Error('Explorer expansion store is not initialized');
  return sharedStore;
}
