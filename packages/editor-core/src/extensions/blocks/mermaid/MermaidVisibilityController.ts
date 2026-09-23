export interface MermaidVisibilityTarget {
  readonly element: HTMLElement;
  setViewportVisible(visible: boolean): void;
}

/**
 * Uses the editor's real scroll container for visibility checks. Webview-hosted
 * IntersectionObserver delivery is not reliable when the workbench restores or
 * moves a custom editor, while scroll hit-testing remains deterministic.
 */
export class MermaidVisibilityController {
  private readonly targets = new Set<MermaidVisibilityTarget>();
  private scrollRoot: HTMLElement | null = null;
  private frame = 0;
  private disposed = false;

  constructor(private readonly preloadPixels = 1200) {}

  observe(target: MermaidVisibilityTarget): void {
    if (this.disposed) return;
    this.targets.add(target);
    this.ensureScrollRoot(target.element);
    this.scheduleCheck();
  }

  unobserve(target: MermaidVisibilityTarget): void {
    this.targets.delete(target);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.scrollRoot?.removeEventListener("scroll", this.scheduleCheck);
    window.removeEventListener("resize", this.scheduleCheck);
    this.scrollRoot = null;
    this.targets.clear();
  }

  private readonly scheduleCheck = (): void => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.checkNow();
    });
  };

  private ensureScrollRoot(element: HTMLElement): void {
    const nextRoot =
      element.closest<HTMLElement>("#editor-scroll-area") ??
      document.getElementById("editor-scroll-area");
    if (!nextRoot || nextRoot === this.scrollRoot) return;
    this.scrollRoot?.removeEventListener("scroll", this.scheduleCheck);
    this.scrollRoot = nextRoot;
    this.scrollRoot.addEventListener("scroll", this.scheduleCheck, {
      passive: true,
    });
    window.addEventListener("resize", this.scheduleCheck, { passive: true });
  }

  private checkNow(): void {
    const first = this.targets.values().next().value as
      MermaidVisibilityTarget | undefined;
    if (!this.scrollRoot && first) this.ensureScrollRoot(first.element);
    const root = this.scrollRoot;
    if (!root) {
      for (const target of this.targets) target.setViewportVisible(true);
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const top = rootRect.top - this.preloadPixels;
    const bottom = rootRect.bottom + this.preloadPixels;
    const left = rootRect.left - this.preloadPixels;
    const right = rootRect.right + this.preloadPixels;
    for (const target of this.targets) {
      if (!target.element.isConnected) {
        target.setViewportVisible(false);
        continue;
      }
      const rect = target.element.getBoundingClientRect();
      target.setViewportVisible(
        rect.bottom > rect.top &&
          rect.right > rect.left &&
          rect.bottom >= top &&
          rect.top <= bottom &&
          rect.right >= left &&
          rect.left <= right,
      );
    }
  }
}
