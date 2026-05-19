<!-- fullWidth: false tocVisible: false tableWrap: true -->
# Markdown Preview WYSIWYG Fork Notes

This repository was reconstructed from the installed `Dykamino.markdown-inline-md` VS Code extension package.

Source recovery:

- `src/host/*` and `src/webview/*` were restored from `dist/extension.js.map` and `dist/webview.js.map`.
- `dist/webview.css` is kept from the installed extension package because no CSS sourcemap was included.
- The original MIT license is preserved in `LICENSE.txt`.

Local changes:

- AI change highlights are retained for 24 hours instead of 8 seconds.
- The "skip when most of the document changed" guard was removed so AI changes are still marked after larger edits.
- AI modified/added blocks also render markers near the editor scrollbar.

Install guidance:

- This fork keeps the original internal custom editor `viewType` and command IDs for compatibility, while the visible editor name is `MdPre-zalman`.
- Disable or uninstall the marketplace version before installing this private VSIX to avoid duplicate command/editor registrations.