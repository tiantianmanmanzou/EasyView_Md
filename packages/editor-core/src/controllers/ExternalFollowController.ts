import { computeGitDiff } from '@easyview/markdown-core/git-diff';

/** Scroll ownership is independent of Git state and transient AI decorations. */
export class ExternalFollowController {
  private enabled = true;
  private queue: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = -1;

  constructor(private readonly revealLine: (line: number) => void, private readonly intervalMs = 320) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.reset();
  }

  enqueue(before: string, after: string, revision: number): void {
    if (!this.enabled || revision <= this.revision) return;
    this.revision = revision;
    const lines = computeGitDiff(before, after).hunks.map((hunk) => hunk.newStart).sort((a, b) => a - b);
    for (const line of lines) {
      if (this.queue.at(-1) !== line) this.queue.push(line);
    }
    this.process();
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.revision = -1;
  }

  dispose(): void { this.reset(); }

  private process(): void {
    if (!this.enabled || this.timer || !this.queue.length) return;
    const line = this.queue.shift()!;
    this.revealLine(line);
    if (this.queue.length) {
      this.timer = setTimeout(() => { this.timer = null; this.process(); }, this.intervalMs);
    }
  }
}
