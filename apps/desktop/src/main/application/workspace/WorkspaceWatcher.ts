import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface WorkspaceWatcherOptions {
  onChange(relativePaths: string[] | null): void;
  debounceMs?: number;
}

export class WorkspaceWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly changedPaths = new Set<string>();
  private reloadAll = false;

  constructor(private readonly rootPath: string, private readonly options: WorkspaceWatcherOptions) {}

  start(): void {
    this.stop();
    this.watcher = watch(this.rootPath, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) {
        this.reloadAll = true;
      } else {
        this.changedPaths.add(String(fileName));
      }
      this.schedule();
    });
    this.watcher.on('error', () => {
      this.reloadAll = true;
      this.schedule();
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changedPaths.clear();
    this.reloadAll = false;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const paths = this.reloadAll
        ? null
        : [...this.changedPaths].map((value) => path.normalize(value));
      this.changedPaths.clear();
      this.reloadAll = false;
      this.options.onChange(paths);
    }, this.options.debounceMs ?? 150);
  }
}
