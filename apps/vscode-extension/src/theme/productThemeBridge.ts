import type * as vscode from 'vscode';
import {
  EASYVIEW_THEME_LEGACY_STORAGE_KEY,
  EASYVIEW_THEME_STORAGE_KEY,
  isEasyViewThemeMode,
  nextEasyViewThemeMode,
  parseEasyViewThemeMode,
  previewFileThemeStorageKey,
  type EasyViewThemeMode,
} from '@easyview/contracts';

const mdPanels = new Set<vscode.WebviewPanel>();
const previewPanels = new Set<vscode.WebviewPanel>();

export function readProductTheme(context: vscode.ExtensionContext): EasyViewThemeMode {
  const primary = context.globalState.get<unknown>(EASYVIEW_THEME_STORAGE_KEY);
  if (isEasyViewThemeMode(primary)) return primary;
  const legacy = context.globalState.get<unknown>(EASYVIEW_THEME_LEGACY_STORAGE_KEY);
  return parseEasyViewThemeMode(legacy, 'light');
}

export async function writeProductTheme(
  context: vscode.ExtensionContext,
  mode: EasyViewThemeMode,
): Promise<void> {
  await context.globalState.update(EASYVIEW_THEME_STORAGE_KEY, mode);
  await context.globalState.update(EASYVIEW_THEME_LEGACY_STORAGE_KEY, mode);
}

export function readPreviewFileTheme(
  context: vscode.ExtensionContext,
  relativePath: string,
): EasyViewThemeMode | null {
  if (!relativePath) return null;
  const raw = context.workspaceState.get<unknown>(previewFileThemeStorageKey(relativePath));
  return isEasyViewThemeMode(raw) ? raw : null;
}

export async function writePreviewFileTheme(
  context: vscode.ExtensionContext,
  relativePath: string,
  mode: EasyViewThemeMode,
): Promise<void> {
  if (!relativePath) return;
  await context.workspaceState.update(previewFileThemeStorageKey(relativePath), mode);
}

export function registerMarkdownThemePanel(panel: vscode.WebviewPanel): vscode.Disposable {
  mdPanels.add(panel);
  return {
    dispose: () => {
      mdPanels.delete(panel);
    },
  };
}

export function registerPreviewThemePanel(panel: vscode.WebviewPanel): vscode.Disposable {
  previewPanels.add(panel);
  return {
    dispose: () => {
      previewPanels.delete(panel);
    },
  };
}

export function broadcastProductTheme(mode: EasyViewThemeMode, except?: vscode.WebviewPanel): void {
  const message = { type: 'setProductTheme', mode };
  for (const panel of mdPanels) {
    if (panel === except) continue;
    void panel.webview.postMessage(message);
  }
  const previewMessage = { type: 'productThemeChanged', mode };
  for (const panel of previewPanels) {
    if (panel === except) continue;
    void panel.webview.postMessage(previewMessage);
  }
}

export async function cycleProductTheme(context: vscode.ExtensionContext): Promise<EasyViewThemeMode> {
  const next = nextEasyViewThemeMode(readProductTheme(context));
  await writeProductTheme(context, next);
  broadcastProductTheme(next);
  return next;
}

export function productThemeBootstrapScript(mode: EasyViewThemeMode): string {
  return `try{localStorage.setItem(${JSON.stringify(EASYVIEW_THEME_STORAGE_KEY)},${JSON.stringify(mode)});localStorage.setItem(${JSON.stringify(EASYVIEW_THEME_LEGACY_STORAGE_KEY)},${JSON.stringify(mode)});}catch(e){}document.documentElement.dataset.easyviewTheme=${JSON.stringify(mode)};document.body&&(document.body.dataset.easyviewTheme=${JSON.stringify(mode)});`;
}
