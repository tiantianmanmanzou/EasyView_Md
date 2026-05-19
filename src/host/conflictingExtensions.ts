import * as vscode from 'vscode';

const MARKDOWN_INLINE_EDITOR_EXTENSION_ID = 'codesmith.markdown-inline-editor-vscode';

type MarkdownInlineEditorDecorator = {
  activeEditor?: vscode.TextEditor;
  isEnabled: () => boolean;
  toggleDecorations: () => boolean;
  setActiveEditor?: (editor: vscode.TextEditor | undefined) => void;
};

type MarkdownInlineEditorApi = {
  decorator?: MarkdownInlineEditorDecorator;
};

export async function suppressConflictingMarkdownInlineDecorations(
  editor: vscode.TextEditor
): Promise<void> {
  const extension = vscode.extensions.getExtension<MarkdownInlineEditorApi>(
    MARKDOWN_INLINE_EDITOR_EXTENSION_ID
  );
  if (!extension) {
    return;
  }

  const api = extension.isActive ? extension.exports : await extension.activate();
  const decorator = api?.decorator;
  if (!decorator) {
    return;
  }

  decorator.setActiveEditor?.(editor);
  const activeUri = decorator.activeEditor?.document.uri.toString();
  if (activeUri !== editor.document.uri.toString()) {
    return;
  }

  if (decorator.isEnabled()) {
    decorator.toggleDecorations();
  }
}
