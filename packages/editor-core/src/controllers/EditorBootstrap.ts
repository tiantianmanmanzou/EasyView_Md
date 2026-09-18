export interface EditorBootstrapInstance {
  dispose?: () => void;
}

export interface EditorBootstrapHandle {
  dispose(): void;
}

export interface EditorBootstrapDeps {
  initialize: () => EditorBootstrapInstance | void;
  installStyles: () => void;
  document?: Document;
}

/** Owns the DOM-ready boundary so editor composition is not part of module bootstrap code. */
export class EditorBootstrap {
  private readonly handle: EditorBootstrapHandle;
  private started = false;
  private disposed = false;
  private initialized = false;
  private instance: EditorBootstrapInstance | undefined;
  private domReadyListener: (() => void) | null = null;

  constructor(private readonly deps: EditorBootstrapDeps) {
    this.handle = {
      dispose: () => this.dispose(),
    };
  }

  start(): EditorBootstrapHandle {
    if (this.started) {
      return this.handle;
    }

    this.started = true;

    if (this.disposed) {
      return this.handle;
    }

    const initialize = () => {
      if (this.disposed || this.initialized) {
        return;
      }

      this.initialized = true;
      this.removeDomReadyListener();
      this.deps.installStyles();
      this.instance = this.deps.initialize() ?? undefined;
    };

    const ownerDocument = this.deps.document ?? document;
    if (ownerDocument.readyState === 'loading') {
      this.domReadyListener = initialize;
      ownerDocument.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
      initialize();
    }

    return this.handle;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.removeDomReadyListener();

    const instance = this.instance;
    this.instance = undefined;
    instance?.dispose?.();
  }

  private removeDomReadyListener(): void {
    if (!this.domReadyListener) {
      return;
    }

    (this.deps.document ?? document).removeEventListener('DOMContentLoaded', this.domReadyListener);
    this.domReadyListener = null;
  }
}
