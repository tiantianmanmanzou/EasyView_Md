/** Settings comment shared by the Webview editor and export controllers. */
export const SETTINGS_COMMENT_RE =
  /^<!--\s*fullWidth:\s*(true|false)(?:\s+tocVisible:\s*(true|false))?(?:\s+tableWrap:\s*(true|false))?(?:\s+lineNumbersVisible:\s*(true|false))?\s*-->[\r\n]*/;

export function stripSettingsComment(content: string): string {
  return content.replace(SETTINGS_COMMENT_RE, '');
}
