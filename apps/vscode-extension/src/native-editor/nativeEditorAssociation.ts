export function nativeEditorAssociationPattern(uri: { scheme: string; path: string }): string {
  return `${uri.scheme}:${uri.path}`;
}

export function applyAssociationPin(
  associations: Record<string, string> | undefined,
  pattern: string,
  viewType: string,
): { next: Record<string, string>; previous: string | undefined } {
  const next = { ...(associations ?? {}) };
  const previous = Object.prototype.hasOwnProperty.call(next, pattern) ? next[pattern] : undefined;
  next[pattern] = viewType;
  return { next, previous };
}

export function removeAssociationPin(
  associations: Record<string, string> | undefined,
  pattern: string,
  previous: string | undefined,
): Record<string, string> {
  const next = { ...(associations ?? {}) };
  if (previous === undefined) {
    delete next[pattern];
  } else {
    next[pattern] = previous;
  }
  return next;
}
