import { execFile } from "node:child_process";
import { tFileClipboard } from "./file-clipboard.i18n";

const MAC_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const urls = $.NSMutableArray.array;
  for (const p of argv) urls.addObject($.NSURL.fileURLWithPath(p));
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  if (!board.writeObjects(urls)) throw new Error("NSPasteboard rejected the files");
  // Items after the first are handed to the pasteboard server from the run loop; exiting at once drops them.
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.3));
}`;

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(tFileClipboard("failed", { message: stderr.trim() || error.message })));
      else resolve();
    });
  });
}

/** Puts files or folders on the OS clipboard so pasting in Finder / Explorer / chat apps yields the originals. */
export async function copyFilesToSystemClipboard(absolutePaths: readonly string[]): Promise<void> {
  if (absolutePaths.length === 0) return;
  if (process.platform === "darwin") {
    await run("osascript", ["-l", "JavaScript", "-e", MAC_SCRIPT, ...absolutePaths]);
    return;
  }
  if (process.platform === "win32") {
    const script = `Set-Clipboard -LiteralPath @(${absolutePaths.map(powershellLiteral).join(",")})`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
    return;
  }
  throw new Error(tFileClipboard("unsupported"));
}
