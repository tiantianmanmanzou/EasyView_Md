import * as vscode from 'vscode';

/** Custom scheme that mirrors disk markdown through our FileSystemProvider. */
export const EASYVIEW_MD_SCHEME = 'easyviewMd';

export function isEasyViewMarkdownUri(uri: vscode.Uri): boolean {
  return uri.scheme === EASYVIEW_MD_SCHEME;
}

export function isDiskBackedMarkdownUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === EASYVIEW_MD_SCHEME;
}

/** Map any EasyView markdown URI to the real on-disk file URI. */
export function toDiskFileUri(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme === 'file') return uri;
  if (uri.scheme === EASYVIEW_MD_SCHEME) return uri.with({ scheme: 'file' });
  return uri;
}

/**
 * All EasyView markdown opens use this URI so CustomTextEditor never depends on
 * Cursor successfully syncing nested-git `file://` TextDocuments to the ext host.
 */
export function toEasyViewMarkdownUri(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme === EASYVIEW_MD_SCHEME) return uri;
  if (uri.scheme === 'file') return uri.with({ scheme: EASYVIEW_MD_SCHEME });
  return uri;
}

export function markdownUriKey(uri: vscode.Uri): string {
  return toDiskFileUri(uri).toString(true);
}

export function sameMarkdownResource(a: vscode.Uri, b: vscode.Uri): boolean {
  return markdownUriKey(a) === markdownUriKey(b);
}
