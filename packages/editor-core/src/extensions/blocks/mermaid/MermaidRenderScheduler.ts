export type MermaidRenderTask = () => Promise<void>;

interface QueuedRender {
  owner: object;
  task: MermaidRenderTask;
  cancelled: boolean;
}

/**
 * Serializes Mermaid's global renderer and coalesces queued work per diagram.
 * Mermaid owns mutable global configuration, so concurrent render calls are not safe.
 */
export class MermaidRenderScheduler {
  private readonly queue: QueuedRender[] = [];
  private readonly queuedByOwner = new Map<object, QueuedRender>();
  private running = false;
  private disposed = false;

  enqueue(owner: object, task: MermaidRenderTask): void {
    if (this.disposed) return;
    const queued = this.queuedByOwner.get(owner);
    if (queued) {
      queued.task = task;
      return;
    }
    const item: QueuedRender = { owner, task, cancelled: false };
    this.queuedByOwner.set(owner, item);
    this.queue.push(item);
    void this.drain();
  }

  cancel(owner: object): void {
    const queued = this.queuedByOwner.get(owner);
    if (!queued) return;
    queued.cancelled = true;
    this.queuedByOwner.delete(owner);
    const index = this.queue.indexOf(queued);
    if (index !== -1) this.queue.splice(index, 1);
  }

  dispose(): void {
    this.disposed = true;
    for (const item of this.queue) item.cancelled = true;
    this.queue.length = 0;
    this.queuedByOwner.clear();
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const item = this.queue.shift();
        if (!item) break;
        if (this.queuedByOwner.get(item.owner) === item) {
          this.queuedByOwner.delete(item.owner);
        }
        if (item.cancelled) continue;
        try {
          await item.task();
        } catch (error) {
          console.warn("[EasyView_Md] Mermaid render failed:", error);
        }
      }
    } finally {
      this.running = false;
      if (!this.disposed && this.queue.length > 0) void this.drain();
    }
  }
}

/** A document-scoped LRU cache sized to retain large Mermaid documents without global leaks. */
export class MermaidSvgCache {
  private readonly data = new Map<string, string>();
  private totalCharacters = 0;

  constructor(
    private readonly maxEntries = 128,
    private readonly maxCharacters = 16 * 1024 * 1024,
  ) {}

  get(key: string): string | undefined {
    const value = this.data.get(key);
    if (value === undefined) return undefined;
    this.data.delete(key);
    this.data.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    const previous = this.data.get(key);
    if (previous !== undefined) {
      this.totalCharacters -= previous.length;
      this.data.delete(key);
    }
    this.data.set(key, value);
    this.totalCharacters += value.length;
    while (
      this.data.size > this.maxEntries ||
      this.totalCharacters > this.maxCharacters
    ) {
      const oldestKey = this.data.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldestValue = this.data.get(oldestKey);
      this.data.delete(oldestKey);
      this.totalCharacters -= oldestValue?.length ?? 0;
    }
  }

  clear(): void {
    this.data.clear();
    this.totalCharacters = 0;
  }

  get size(): number {
    return this.data.size;
  }
}
