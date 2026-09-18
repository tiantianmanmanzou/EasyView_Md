/** @vitest-environment node */
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { buildXlsxBuffer } from '../src/export/xlsx-export';
import { writeHtmlExport } from '../src/export/html-export';
import { isAllowedImageUrl, resolveAndValidateImageUrl } from '../src/image/remote-image';
import { writePdfBase64 } from '../src/export/pdf-export';
import type { XlsxTablePayload } from "@easyview/contracts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("buildXlsxBuffer", () => {
  it("preserves workbook formatting behavior from the VS Code host", async () => {
    const payload: XlsxTablePayload = {
      totalRows: 2,
      totalCols: 3,
      cells: [
        {
          row: 0,
          col: 0,
          text: "一级",
          rowspan: 2,
          colspan: 1,
          isHeader: true,
          alignment: "left",
          verticalAlignment: "top",
        },
        {
          row: 0,
          col: 1,
          text: "一级描述",
          rowspan: 2,
          colspan: 1,
          isHeader: true,
          alignment: "left",
          verticalAlignment: "top",
        },
        {
          row: 0,
          col: 2,
          text: "三级A",
          rowspan: 1,
          colspan: 1,
          isHeader: false,
          alignment: null,
          verticalAlignment: null,
        },
        {
          row: 1,
          col: 2,
          text: "三级B",
          rowspan: 1,
          colspan: 1,
          isHeader: false,
          alignment: null,
          verticalAlignment: null,
        },
      ],
      merges: [
        { top: 0, left: 0, bottom: 1, right: 0 },
        { top: 0, left: 1, bottom: 1, right: 1 },
      ],
      columnWidths: [100, 120, 80],
      rowHeights: [40, 40],
    };

    const buffer = await buildXlsxBuffer(payload);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const worksheet = workbook.getWorksheet("Sheet1")!;

    expect(worksheet.getCell("A1").value).toBe("一级");
    expect(worksheet.getCell("C1").value).toBe("三级A");
    expect(worksheet.getCell("C2").value).toBe("三级B");
    expect(worksheet.model.merges).toEqual(["A1:A2", "B1:B2"]);
    expect(worksheet.getCell("A1").border?.top?.style).toBe("thin");
    expect(worksheet.getCell("A1").font?.bold).toBe(true);
    expect(worksheet.getCell("C2").font?.bold).toBeFalsy();
  });
});

describe("writeHtmlExport", () => {
  it("writes a plain HTML export to the requested target path", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "easyview-node-services-"),
    );
    tempDirectories.push(root);
    const targetPath = path.join(root, "out", "note.html");

    const result = await writeHtmlExport({
      targetPath,
      documentDir: root,
      html: "<h1>标题</h1>",
      images: [],
    });

    expect(result.htmlPath).toBe(targetPath);
    expect(await readFile(targetPath, "utf8")).toBe("<h1>标题</h1>");
  });

  it("writes images into the export images directory and reports missing images", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "easyview-node-services-"),
    );
    tempDirectories.push(root);
    const sourcePath = path.join(root, "source.png");
    await writeFile(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const targetPath = path.join(root, "note.html");

    const result = await writeHtmlExport({
      targetPath,
      documentDir: root,
      html: '<img src="./images/source.png">',
      images: [
        {
          originalSrc: "source.png",
          exportFilename: "source.png",
          isExternal: false,
        },
        {
          originalSrc: "missing.png",
          exportFilename: "missing.png",
          isExternal: false,
        },
      ],
    });

    expect(result.htmlPath).toBe(path.join(root, "note", "note.html"));
    expect(
      await readFile(path.join(root, "note", "images", "source.png")),
    ).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(result.failedImages).toEqual(["missing.png"]);
  });
});


  it("rejects export filenames that escape the images directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easyview-node-services-"));
    tempDirectories.push(root);
    const sourcePath = path.join(root, "source.png");
    await writeFile(sourcePath, Buffer.from([1, 2, 3]));

    const result = await writeHtmlExport({
      targetPath: path.join(root, "note.html"),
      documentDir: root,
      html: "<p>safe</p>",
      images: [{ originalSrc: "source.png", exportFilename: "../outside.png", isExternal: false }],
    });

    expect(result.failedImages).toEqual(["source.png"]);
    await expect(readFile(path.join(root, "outside.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects absolute, parent-traversal, and symlinked local images", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easyview-node-services-"));
    tempDirectories.push(root);
    const outside = await mkdtemp(path.join(os.tmpdir(), "easyview-node-services-outside-"));
    tempDirectories.push(outside);
    const outsidePath = path.join(outside, "secret.png");
    await writeFile(outsidePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await symlink(outsidePath, path.join(root, "linked.png"));

    const result = await writeHtmlExport({
      targetPath: path.join(root, "note.html"),
      documentDir: root,
      html: "<p>safe</p>",
      images: [
        { originalSrc: outsidePath, exportFilename: "absolute.png", isExternal: false },
        { originalSrc: "../secret.png", exportFilename: "parent.png", isExternal: false },
        { originalSrc: "linked.png", exportFilename: "linked.png", isExternal: false },
      ],
    });

    expect(result.failedImages).toEqual([outsidePath, "../secret.png", "linked.png"]);
    expect(await realpath(outsidePath)).toBe(await realpath(path.join(outside, "secret.png")));
  });

  it("rejects local image MIME and extension mismatches and oversized files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easyview-node-services-"));
    tempDirectories.push(root);
    await writeFile(path.join(root, "wrong.jpg"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(path.join(root, "large.png"), Buffer.alloc(20 * 1024 * 1024 + 1));

    const result = await writeHtmlExport({
      targetPath: path.join(root, "note.html"),
      documentDir: root,
      html: "<p>safe</p>",
      images: [
        { originalSrc: "wrong.jpg", exportFilename: "wrong.jpg", isExternal: false },
        { originalSrc: "large.png", exportFilename: "large.png", isExternal: false },
      ],
    });

    expect(result.failedImages).toEqual(["wrong.jpg", "large.png"]);
  });

  it("blocks local, private, link-local, and metadata remote hosts before DNS/network access", async () => {
    const blocked = [
      "http://localhost/image.png",
      "http://127.0.0.1/image.png",
      "http://10.0.0.1/image.png",
      "http://172.16.0.1/image.png",
      "http://192.168.0.1/image.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/image.png",
    ];
    for (const url of blocked) expect(isAllowedImageUrl(url)).toBe(false);

    await expect(resolveAndValidateImageUrl("http://public.example/image.png", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ])).rejects.toThrow("private or local");

    await expect(resolveAndValidateImageUrl("http://public.example/image.png", async () => [
      { address: "93.184.216.34", family: 4 },
    ])).resolves.toEqual(new URL("http://public.example/image.png"));
  });

  it("accepts image responses only after bounded redirects and content validation", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/bad-type") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("not an image");
        return;
      }
      const redirect = Number((request.url ?? "").slice(1));
      if (Number.isInteger(redirect) && redirect >= 0) {
        response.writeHead(302, { location: `/${redirect + 1}` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([137, 80, 78, 71]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      const base = `http://127.0.0.1:${address.port}`;
      const root = await mkdtemp(path.join(os.tmpdir(), "easyview-node-services-"));
      tempDirectories.push(root);
      const result = await writeHtmlExport({
        targetPath: path.join(root, "remote.html"),
        documentDir: root,
        html: "<p>remote</p>",
        images: [
          { originalSrc: `${base}/bad-type`, exportFilename: "bad.png", isExternal: true },
          { originalSrc: `${base}/0`, exportFilename: "too-many.png", isExternal: true },
        ],
      });
      expect(result.failedImages).toEqual([`${base}/bad-type`, `${base}/0`]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

describe("writePdfBase64", () => {
  it("decodes and writes PDF bytes to the requested path", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "easyview-node-services-"),
    );
    tempDirectories.push(root);
    const targetPath = path.join(root, "out", "note.pdf");
    const bytes = Buffer.from("%PDF-test");

    const result = await writePdfBase64({
      targetPath,
      data: bytes.toString("base64"),
    });

    expect(result.filePath).toBe(targetPath);
    expect(result.byteLength).toBe(bytes.length);
    expect(await readFile(targetPath)).toEqual(bytes);

    const replacement = Buffer.from("%PDF-replacement");
    await writePdfBase64({ targetPath, data: replacement.toString("base64") });
    expect(await readFile(targetPath)).toEqual(replacement);
  });
});
