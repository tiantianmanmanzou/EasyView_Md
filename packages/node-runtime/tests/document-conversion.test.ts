/** @vitest-environment node */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DocumentConversionError,
  convertDocumentToMarkdown,
  flattenPngWithWhiteBackground,
  markdownImageReferences,
  pdfTextToMarkdown,
  rewriteExtractedMediaPaths,
} from '../src/conversion/document-conversion';
import { PNG } from "pngjs";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "easyview-document-conversion-"));
}

describe("document conversion helpers", () => {
  it("preserves the portable media path and converts dimensioned HTML images", () => {
    const markdown = '<img src="/tmp/work/media/image.png" alt="图" style="width: 20px; height: 10px">';
    expect(rewriteExtractedMediaPaths(markdown, "/tmp/work/media", "report.assets"))
      .toBe("![图](./report.assets/image.png){width=20px height=10px}");
  });

  it("flattens transparent PNG pixels against white", () => {
    const png = new PNG({ width: 1, height: 1 });
    png.data[0] = 0;
    png.data[1] = 0;
    png.data[2] = 0;
    png.data[3] = 128;
    const flattened = PNG.sync.read(flattenPngWithWhiteBackground(PNG.sync.write(png)));
    expect(flattened.data[0]).toBe(127);
    expect(flattened.data[1]).toBe(127);
    expect(flattened.data[2]).toBe(127);
    expect(flattened.data[3]).toBe(255);
  });

  it("normalizes PDF text and produces portable image references", () => {
    expect(pdfTextToMarkdown("标题\r\n\r\n\r\n正文\f下一页")).toBe("标题\n\n正文\n\n---\n\n下一页");
    expect(markdownImageReferences("doc.assets", ["/tmp/image-10.png", "/tmp/image-2.png"]))
      .toBe("![](./doc.assets/image-2.png)\n\n![](./doc.assets/image-10.png)");
  });

  it("requires an explicit overwrite flag when the output already exists", async () => {
    const root = await temporaryDirectory();
    try {
      const sourcePath = path.join(root, "sample.pdf");
      await writeFile(sourcePath, Buffer.from("not a PDF"));
      await writeFile(path.join(root, "sample.md"), "existing");
      await expect(convertDocumentToMarkdown({ sourcePath, overwrite: false })).rejects.toMatchObject({
        code: "OUTPUT_EXISTS",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a clear error for an unsupported source type", async () => {
    const sourcePath = path.join(await temporaryDirectory(), "sample.txt");
    try {
      await writeFile(sourcePath, "text");
      await expect(convertDocumentToMarkdown({ sourcePath, overwrite: false })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    } finally {
      await rm(path.dirname(sourcePath), { recursive: true, force: true });
    }
  });
});

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { convertPdfToMarkdown, convertWordToMarkdown } from '../src/conversion/document-conversion';

const execFileNative = promisify(execFileCallback);

async function hasCommand(command: string): Promise<boolean> {
  try {
    await execFileNative("sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

describe("native document conversion", () => {
  it("converts a PDF with Poppler when the local toolchain is available", async () => {
    if (!(await hasCommand("pdftotext")) || !(await hasCommand("pdfimages")) || !(await hasCommand("pdftoppm"))) return;
    const root = await temporaryDirectory();
    try {
      const sourceHtml = path.join(root, "report.html");
      const sourcePdf = path.join(root, "report.pdf");
      await writeFile(sourceHtml, "<html><body><h1>Native PDF conversion</h1><p>正文</p></body></html>");
      await execFileNative("soffice", ["--headless", "--convert-to", "pdf", "--outdir", root, sourceHtml]);
      const result = await convertPdfToMarkdown({ sourcePath: sourcePdf, overwrite: false });
      expect(result.outputPath).toBe(path.join(root, "report.md"));
      expect(await readFile(result.outputPath, "utf8")).toContain("Native PDF conversion");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts a DOCX through Pandoc and preserves a portable assets directory", async () => {
    if (!(await hasCommand("soffice")) || !(await hasCommand("pandoc"))) return;
    const root = await temporaryDirectory();
    try {
      const sourceMarkdown = path.join(root, "report-input.md");
      const sourceDocx = path.join(root, "report.docx");
      await writeFile(sourceMarkdown, "# Native Word conversion\n\n正文\n");
      await execFileNative("pandoc", [sourceMarkdown, "--from=gfm", "--to=docx", `--output=${sourceDocx}`]);
      const result = await convertWordToMarkdown({ sourcePath: sourceDocx, overwrite: false });
      expect(result.outputPath).toBe(path.join(root, "report.md"));
      expect(await readFile(result.outputPath, "utf8")).toContain("Native Word conversion");
      expect(result.markdown).not.toContain("file://");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
