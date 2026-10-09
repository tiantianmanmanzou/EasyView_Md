import * as vscode from 'vscode';
import { isEasyViewMarkdownUri, toDiskFileUri, toEasyViewMarkdownUri } from './markdownUri';

/** Rename through the resource identity owned by the open text model. */
export async function renameMarkdownResource(source: vscode.Uri, target: vscode.Uri): Promise<boolean> {
  const diskSource = toDiskFileUri(source);
  const diskTarget = toDiskFileUri(target);
  if (diskSource.toString() === diskTarget.toString()) return true;

  const sourcePath = diskSource.path;
  const hasEasyViewDocument = vscode.workspace.textDocuments.some((document) => {
    if (document.isClosed || !isEasyViewMarkdownUri(document.uri)) return false;
    const diskUri = toDiskFileUri(document.uri);
    return diskUri.authority === diskSource.authority
      && (diskUri.path === sourcePath || diskUri.path.startsWith(`${sourcePath}/`));
  });
  const useEasyView = isEasyViewMarkdownUri(source) || hasEasyViewDocument;
  const editors = vscode.window.tabGroups.all.flatMap((group) => group.tabs.flatMap((tab) => {
    if (!(tab.input instanceof vscode.TabInputCustom)) return [];
    const uri = toDiskFileUri(tab.input.uri);
    if (uri.authority !== diskSource.authority
      || (uri.path !== sourcePath && !uri.path.startsWith(`${sourcePath}/`))) return [];
    return [{
      uri: tab.input.uri.with({ path: `${diskTarget.path}${uri.path.slice(sourcePath.length)}` }),
      viewType: tab.input.viewType,
      options: { viewColumn: group.viewColumn, preview: tab.isPreview, preserveFocus: !tab.isActive },
    }];
  }));
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(
    useEasyView ? toEasyViewMarkdownUri(diskSource) : diskSource,
    useEasyView ? toEasyViewMarkdownUri(diskTarget) : diskTarget,
    { overwrite: false, ignoreIfExists: false },
  );
  const renamed = await vscode.workspace.applyEdit(edit);
  if (!renamed) return false;
  // VS Code relocates the text model but resolves a renamed custom tab using
  // the default editor. Keep the original view type on that relocated model.
  for (const editor of editors) {
    await vscode.commands.executeCommand('vscode.openWith', editor.uri, editor.viewType, editor.options);
  }
  return true;
}
