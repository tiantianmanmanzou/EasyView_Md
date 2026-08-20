import * as vscode from 'vscode';
import { isMarkdownDocument } from './markdownModel';
import {
  applyAssociationPin,
  nativeEditorAssociationPattern,
  removeAssociationPin,
} from './nativeEditorAssociation';
import { logOpenWithDebug } from './openWithDebug';

const PIN_STATE_KEY = 'easyviewMd.nativeEditorAssociationPins';
const RESTORE_WINDOW_MS = 2000;
const DEFAULT_EDITOR_ID = 'default';

interface NativeNavigation {
  uri: string;
  at: number;
  selection: vscode.Selection;
  viewColumn: vscode.ViewColumn | undefined;
}

interface AssociationPin {
  uri: string;
  pattern: string;
  previous: string | undefined;
}

let lastCommandNavigation: NativeNavigation | undefined;
let suppressRestoreUntil = 0;
let restoring = false;
let associationWrite: Promise<void> = Promise.resolve();

/** Skip outline restore while EasyView is being opened on purpose. */
export function suppressNativeOutlineRestore(ms = 1500): void {
  suppressRestoreUntil = Date.now() + ms;
}

function isEasyViewTab(tab: vscode.Tab | undefined, viewType: string): tab is vscode.Tab & { input: vscode.TabInputCustom } {
  return Boolean(
    tab?.input instanceof vscode.TabInputCustom
    && tab.input.viewType === viewType
  );
}

function isMarkdownHeadingLine(document: vscode.TextDocument, line: number): boolean {
  if (line < 0 || line >= document.lineCount) return false;
  return /^#{1,6}\s/.test(document.lineAt(line).text);
}

function rememberCommandNavigation(editor: vscode.TextEditor): void {
  if (!isMarkdownHeadingLine(editor.document, editor.selection.active.line)) return;
  lastCommandNavigation = {
    uri: editor.document.uri.toString(),
    at: Date.now(),
    selection: editor.selection,
    viewColumn: editor.viewColumn,
  };
}

function readPins(context: vscode.ExtensionContext): AssociationPin[] {
  return context.globalState.get<AssociationPin[]>(PIN_STATE_KEY, []);
}

function writePins(context: vscode.ExtensionContext, pins: AssociationPin[]): Thenable<void> {
  return context.globalState.update(PIN_STATE_KEY, pins);
}

function readGlobalAssociations(): Record<string, string> {
  const inspect = vscode.workspace.getConfiguration('workbench').inspect<Record<string, string>>('editorAssociations');
  return { ...(inspect?.globalValue ?? {}) };
}

async function writeGlobalAssociations(associations: Record<string, string>): Promise<void> {
  const config = vscode.workspace.getConfiguration('workbench');
  await config.update(
    'editorAssociations',
    Object.keys(associations).length > 0 ? associations : undefined,
    vscode.ConfigurationTarget.Global,
  );
}

function queueAssociationWrite(task: () => Promise<void>): Promise<void> {
  associationWrite = associationWrite.then(task, task);
  return associationWrite;
}

function nativeMarkdownTabs(): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const seen = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const uri = tab.input.uri;
      const key = uri.toString();
      if (seen.has(key)) continue;
      const document = vscode.workspace.textDocuments.find((item) => item.uri.toString() === key);
      if (document && !isMarkdownDocument(document)) continue;
      if (!document && !/\.(md|markdown|mdx)$/i.test(uri.fsPath)) continue;
      seen.add(key);
      uris.push(uri);
    }
  }
  return uris;
}

function easyViewIsConfiguredDefault(viewType: string): boolean {
  const merged = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('editorAssociations') ?? {};
  return Object.values(merged).includes(viewType);
}

async function pinNativeEditorAssociation(
  context: vscode.ExtensionContext,
  viewType: string,
  uri: vscode.Uri,
): Promise<void> {
  if (!easyViewIsConfiguredDefault(viewType)) return;
  const pattern = nativeEditorAssociationPattern(uri);
  const uriKey = uri.toString();
  await queueAssociationWrite(async () => {
    const pins = readPins(context);
    const associations = readGlobalAssociations();
    const existingPin = pins.find((pin) => pin.uri === uriKey);

    if (associations[pattern] === DEFAULT_EDITOR_ID) {
      if (!existingPin) {
        await writePins(context, [...pins, { uri: uriKey, pattern, previous: DEFAULT_EDITOR_ID }]);
      }
      return;
    }

    const { next, previous } = applyAssociationPin(associations, pattern, DEFAULT_EDITOR_ID);
    try {
      await writeGlobalAssociations(next);
    } catch (error) {
      logOpenWithDebug('outline.pinNativeDefault.failed', {
        path: uri.fsPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const nextPins = pins.filter((pin) => pin.uri !== uriKey);
    nextPins.push({ uri: uriKey, pattern, previous: existingPin?.previous ?? previous });
    await writePins(context, nextPins);
    logOpenWithDebug('outline.pinNativeDefault', {
      path: uri.fsPath,
      pattern,
      previous: previous ?? '<unset>',
    });
  });
}

async function unpinNativeEditorAssociation(context: vscode.ExtensionContext, uriKey: string): Promise<void> {
  await queueAssociationWrite(async () => {
    const pins = readPins(context);
    const pin = pins.find((item) => item.uri === uriKey);
    if (!pin) return;

    const associations = readGlobalAssociations();
    if (associations[pin.pattern] === DEFAULT_EDITOR_ID) {
      await writeGlobalAssociations(removeAssociationPin(associations, pin.pattern, pin.previous));
    }

    await writePins(context, pins.filter((item) => item.uri !== uriKey));
    logOpenWithDebug('outline.unpinNativeDefault', {
      uri: uriKey,
      pattern: pin.pattern,
    });
  });
}

async function syncNativeEditorAssociationPins(
  context: vscode.ExtensionContext,
  viewType: string,
): Promise<void> {
  if (!easyViewIsConfiguredDefault(viewType)) {
    await restoreAllAssociationPins(context);
    return;
  }
  const openNative = nativeMarkdownTabs();
  const openNativeKeys = new Set(openNative.map((uri) => uri.toString()));
  for (const uri of openNative) {
    await pinNativeEditorAssociation(context, viewType, uri);
  }
  for (const pin of readPins(context)) {
    if (!openNativeKeys.has(pin.uri)) {
      await unpinNativeEditorAssociation(context, pin.uri);
    }
  }
}

async function restoreAllAssociationPins(context: vscode.ExtensionContext): Promise<void> {
  for (const pin of readPins(context)) {
    await unpinNativeEditorAssociation(context, pin.uri);
  }
}

async function restoreNativeEditor(uri: vscode.Uri, navigation: NativeNavigation): Promise<void> {
  if (restoring) return;
  restoring = true;
  lastCommandNavigation = undefined;
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, DEFAULT_EDITOR_ID, {
      viewColumn: navigation.viewColumn,
      preserveFocus: false,
      preview: false,
      selection: navigation.selection,
    });
  } finally {
    restoring = false;
  }
}

function maybeRestoreFromEasyView(viewType: string, uri?: vscode.Uri): void {
  if (restoring) return;
  if (Date.now() < suppressRestoreUntil) return;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!isEasyViewTab(tab, viewType)) return;

  const targetUri = uri ?? tab.input.uri;
  const navigation = lastCommandNavigation;
  if (!navigation) return;
  if (navigation.uri !== targetUri.toString()) return;
  if (Date.now() - navigation.at > RESTORE_WINDOW_MS) return;

  logOpenWithDebug('outline.restoreNativeEditor', { path: targetUri.fsPath });
  void restoreNativeEditor(targetUri, navigation);
}

/**
 * Outline uses openEditor on the Markdown URI without `override: default`.
 * If EasyView is the configured editor for `*.md`, VS Code activates that tab
 * instead of scrolling the native text editor. While a native Markdown tab is
 * open, pin a more-specific association so Outline keeps using the text editor.
 */
export function registerNativeOutlineNavigationGuard(
  context: vscode.ExtensionContext,
  viewType: string,
): vscode.Disposable {
  void syncNativeEditorAssociationPins(context, viewType);

  const selectionListener = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (restoring) return;
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Command) return;
    if (!isMarkdownDocument(event.textEditor.document)) return;
    rememberCommandNavigation(event.textEditor);
    maybeRestoreFromEasyView(viewType, event.textEditor.document.uri);
  });

  const tabListener = vscode.window.tabGroups.onDidChangeTabs(() => {
    void syncNativeEditorAssociationPins(context, viewType);
    maybeRestoreFromEasyView(viewType);
  });

  const activeEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && isMarkdownDocument(editor.document)) {
      void pinNativeEditorAssociation(context, viewType, editor.document.uri);
    }
    if (editor || restoring) return;
    setTimeout(() => maybeRestoreFromEasyView(viewType), 0);
  });

  return vscode.Disposable.from(
    selectionListener,
    tabListener,
    activeEditorListener,
    { dispose: () => { void restoreAllAssociationPins(context); } },
  );
}
