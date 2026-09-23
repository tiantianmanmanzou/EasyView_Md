import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { logOpenWithDebug } from './openWithDebug';
import {
  isEasyViewMarkdownUri,
  toDiskFileUri,
  toEasyViewMarkdownUri,
} from './markdownUri';

const VIEW_TYPE = 'easyviewMd.markdownEditor';

export interface OpenMarkdownEditorOptions {
  viewColumn?: vscode.ViewColumn;
  preview?: boolean;
  preserveFocus?: boolean;
}

/**
 * Resolve a workspace markdown URI into one CustomTextEditor can always open.
 * Prefer `easyviewMd:` (FS provider on this host). If that still cannot sync,
 * materialize a storage mirror outside nested git trees.
 */
export async function openMarkdownInEasyViewEditor(
  rawUri: vscode.Uri,
  context: vscode.ExtensionContext,
  viewColumnOrOptions?: vscode.ViewColumn | OpenMarkdownEditorOptions,
): Promise<vscode.Uri> {
  const options = normalizeOpenOptions(viewColumnOrOptions);
  const diskUri = toDiskFileUri(rawUri.scheme === 'file' || isEasyViewMarkdownUri(rawUri)
    ? rawUri
    : vscode.Uri.file(rawUri.fsPath));

  const primaryUri = toEasyViewMarkdownUri(diskUri);
  try {
    const document = await vscode.workspace.openTextDocument(primaryUri);
    logOpenWithDebug('openMarkdown.primaryScheme', {
      path: diskUri.fsPath,
      openUri: document.uri.toString(true),
      length: document.getText().length,
      preview: options.preview === true,
      preserveFocus: options.preserveFocus === true,
    });
    await vscode.commands.executeCommand('vscode.openWith', document.uri, VIEW_TYPE, options);
    return document.uri;
  } catch (primaryError) {
    logOpenWithDebug('openMarkdown.primarySchemeFailed', {
      path: diskUri.fsPath,
      message: primaryError instanceof Error ? primaryError.message : String(primaryError),
    });
  }

  const mirrorUri = await materializeStorageMirror(context, diskUri);
  const mirrored = await vscode.workspace.openTextDocument(mirrorUri);
  logOpenWithDebug('openMarkdown.storageMirror', {
    path: diskUri.fsPath,
    mirror: mirrorUri.fsPath,
    length: mirrored.getText().length,
  });
  await vscode.commands.executeCommand('vscode.openWith', mirrored.uri, VIEW_TYPE, options);
  return mirrored.uri;
}

function normalizeOpenOptions(
  viewColumnOrOptions?: vscode.ViewColumn | OpenMarkdownEditorOptions,
): OpenMarkdownEditorOptions {
  if (viewColumnOrOptions === undefined) return {};
  if (typeof viewColumnOrOptions === 'number') {
    return { viewColumn: viewColumnOrOptions };
  }
  return viewColumnOrOptions;
}

async function materializeStorageMirror(
  context: vscode.ExtensionContext,
  diskUri: vscode.Uri,
): Promise<vscode.Uri> {
  const root = context.storageUri ?? context.globalStorageUri;
  if (!root) {
    throw new Error('No extension storage URI available for markdown mirror.');
  }

  const digest = createHash('sha1').update(diskUri.fsPath).digest('hex').slice(0, 16);
  const baseName = path.basename(diskUri.fsPath);
  const mirrorDir = vscode.Uri.joinPath(root, 'markdown-mirrors', digest);
  const mirrorUri = vscode.Uri.joinPath(mirrorDir, baseName);

  await vscode.workspace.fs.createDirectory(mirrorDir);
  const bytes = await vscode.workspace.fs.readFile(diskUri);
  await vscode.workspace.fs.writeFile(mirrorUri, bytes);

  // Remember original path so save/git/image code can resolve the real file.
  bindMirrorToDisk(mirrorUri, diskUri);
  return mirrorUri;
}

const mirrorBindings = new Map<string, string>();

export function bindMirrorToDisk(mirrorUri: vscode.Uri, diskUri: vscode.Uri): void {
  mirrorBindings.set(mirrorUri.toString(true), diskUri.toString(true));
}

export function resolveMarkdownDiskUri(uri: vscode.Uri): vscode.Uri {
  const bound = mirrorBindings.get(uri.toString(true));
  if (bound) return vscode.Uri.parse(bound);
  return toDiskFileUri(uri);
}

/**
 * Window restore may reopen historical EasyView tabs with `file://` URIs.
 * Those hit Cursor's nested-git TextDocument sync failure before resolve.
 * Rematerialize them through the `easyviewMd:` open path.
 */
export async function rematerializeFileSchemeEasyViewMarkdownTabs(
  context: vscode.ExtensionContext,
): Promise<void> {
  const victims: Array<{ tab: vscode.Tab; uri: vscode.Uri; viewColumn: vscode.ViewColumn | undefined }> = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputCustom)) continue;
      if (tab.input.viewType !== VIEW_TYPE) continue;
      if (tab.input.uri.scheme !== 'file') continue;
      if (!/\.(md|markdown|mdx)$/i.test(tab.input.uri.fsPath)) continue;
      victims.push({ tab, uri: tab.input.uri, viewColumn: group.viewColumn });
    }
  }

  for (const { tab, uri, viewColumn } of victims) {
    try {
      await vscode.window.tabGroups.close(tab);
      await openMarkdownInEasyViewEditor(uri, context, {
        viewColumn,
        preview: tab.isPreview,
        preserveFocus: true,
      });
      logOpenWithDebug('migrate.fileSchemeTab.reopened', { path: uri.fsPath });
    } catch (error) {
      logOpenWithDebug('migrate.fileSchemeTab.failed', {
        path: uri.fsPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
