export interface EditorBootstrapDeps {
  initialize: () => void;
  installStyles: () => void;
}

/** Owns the DOM-ready boundary so editor composition is not part of module bootstrap code. */
export class EditorBootstrap {
  constructor(private readonly deps: EditorBootstrapDeps) {}

  start(): void {
    const start = () => {
      this.deps.installStyles();
      this.deps.initialize();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
}
