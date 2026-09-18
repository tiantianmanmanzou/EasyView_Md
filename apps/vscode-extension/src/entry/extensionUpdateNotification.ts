import * as vscode from 'vscode';

const LAST_ACTIVATED_VERSION_KEY = 'easyviewMd.lastActivatedVersion';
const VIEW_RELEASE_NOTES_ACTION = 'View Release Notes';
const RELEASE_NOTES_URL = 'https://github.com/tiantianmanmanzou/EasyView_Md/blob/main/readme.md';

/** Record the installed version and notify only when a previously installed version changed. */
export async function notifyExtensionUpdated(
  context: vscode.ExtensionContext,
  currentVersion: string,
): Promise<boolean> {
  const previousVersion = context.globalState.get<string>(LAST_ACTIVATED_VERSION_KEY);
  await context.globalState.update(LAST_ACTIVATED_VERSION_KEY, currentVersion);

  // A missing version means first installation, not an update.
  if (!previousVersion || previousVersion === currentVersion) {
    return false;
  }

  const action = await vscode.window.showInformationMessage(
    `EasyView_Md updated from v${previousVersion} to v${currentVersion}.`,
    VIEW_RELEASE_NOTES_ACTION,
  );
  if (action === VIEW_RELEASE_NOTES_ACTION) {
    await vscode.env.openExternal(vscode.Uri.parse(RELEASE_NOTES_URL));
  }
  return true;
}

export function getInstalledExtensionVersion(): string | undefined {
  const extension = vscode.extensions.getExtension('zhangxy.easyview-md');
  const version = extension?.packageJSON?.version;
  return typeof version === 'string' ? version : undefined;
}
