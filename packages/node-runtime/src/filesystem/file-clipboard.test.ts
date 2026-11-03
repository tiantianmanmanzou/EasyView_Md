import { afterEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

import { copyFilesToSystemClipboard } from "./file-clipboard";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  setPlatform(originalPlatform);
  execFile.mockReset();
});

describe("copyFilesToSystemClipboard", () => {
  it("passes every path to the macOS pasteboard script", async () => {
    setPlatform("darwin");
    execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(null, "", ""));
    await copyFilesToSystemClipboard(["/a/b.md", "/a/dir"]);
    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe("osascript");
    expect(args.slice(0, 2)).toEqual(["-l", "JavaScript"]);
    expect(args.slice(-2)).toEqual(["/a/b.md", "/a/dir"]);
  });

  it("quotes Windows paths as PowerShell literals", async () => {
    setPlatform("win32");
    execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(null, "", ""));
    await copyFilesToSystemClipboard(["C:\\docs\\it's.md", "C:\\docs\\dir"]);
    const [command, args] = execFile.mock.calls[0];
    expect(command).toBe("powershell.exe");
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    expect(script).toBe("Set-Clipboard -LiteralPath @('C:\\docs\\it''s.md','C:\\docs\\dir')");
  });

  it("reports the command error", async () => {
    setPlatform("darwin");
    execFile.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error("exit 1"), "", "denied"));
    await expect(copyFilesToSystemClipboard(["/a"])).rejects.toThrow("denied");
  });

  it("rejects unsupported platforms", async () => {
    setPlatform("linux");
    await expect(copyFilesToSystemClipboard(["/a"])).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });
});
