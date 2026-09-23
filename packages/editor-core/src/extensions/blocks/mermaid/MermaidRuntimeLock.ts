let mermaidRuntimeTail: Promise<void> = Promise.resolve();

/**
 * Mermaid exposes mutable process-wide configuration. All editor and export
 * rendering must pass through this lock so themes and parser state cannot race.
 */
export function withMermaidRuntimeLock<T>(task: () => Promise<T>): Promise<T> {
  const result = mermaidRuntimeTail.catch(() => undefined).then(task);
  mermaidRuntimeTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
