import * as vscode from 'vscode';

export const NATIVE_MARKDOWN_MONOSPACE_FONT_FAMILY = '"Sarasa Mono SC", "Sarasa Fixed SC", "SF Mono", Menlo, Monaco, "Courier New", monospace';

export function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return ['markdown', 'mdx'].includes(document.languageId)
    || /\.(md|markdown|mdx)$/i.test(document.uri.fsPath);
}

export async function ensureNativeMarkdownEditorFont(document: vscode.TextDocument): Promise<void> {
  if (!isMarkdownDocument(document)) {
    return;
  }

  const inlineConfig = vscode.workspace.getConfiguration('inlineMd', document.uri);
  if (!inlineConfig.get<boolean>('nativeEditor.forceMonospaceFont', true)) {
    return;
  }
  // Do not mutate user settings while opening native source mode.
  // Language-scoped defaults already come from package.json configurationDefaults,
  // and explicit user/workspace overrides should remain authoritative.
  return;
}
