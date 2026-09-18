import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ImageServiceError, pickImage, readImageAsDataUrl, savePastedImage } from '../src/image/image-service';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

async function withDocument(run: (documentPath: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easyview-image-service-"));
  const documentPath = path.join(root, "设计 文档.md");
  await writeFile(documentPath, "# test");
  try {
    await run(documentPath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("image service", () => {
  it("normalizes data URLs and reads safe local images", async () => {
    await withDocument(async (documentPath, root) => {
      await writeFile(path.join(root, "image.png"), PNG_BYTES);
      expect(await readImageAsDataUrl({ documentPath, source: "./image.png" })).toBe(PNG_DATA_URL);
      expect(await readImageAsDataUrl({ documentPath, source: PNG_DATA_URL })).toBe(PNG_DATA_URL);
      await expect(readImageAsDataUrl({ documentPath, source: "data:text/plain;base64,SGk=" }))
        .rejects.toMatchObject({ code: "UNSUPPORTED_MIME" });
    });
  });

  it("blocks traversal, symlinks, and absolute local paths", async () => {
    await withDocument(async (documentPath, root) => {
      await expect(readImageAsDataUrl({ documentPath, source: "../outside.png" }))
        .rejects.toMatchObject({ code: "IMAGE_PATH_OUTSIDE_DOCUMENT" });
      await expect(readImageAsDataUrl({ documentPath, source: "/tmp/outside.png" }))
        .rejects.toMatchObject({ code: "IMAGE_PATH_OUTSIDE_DOCUMENT" });
      const outside = path.join(path.dirname(root), "outside.png");
      await writeFile(outside, PNG_BYTES);
      await symlink(outside, path.join(root, "linked.png"));
      await expect(readImageAsDataUrl({ documentPath, source: "./linked.png" }))
        .rejects.toMatchObject({ code: "IMAGE_PATH_OUTSIDE_DOCUMENT" });
    });
  });

  it("validates DNS, redirects, timeout, size, and remote MIME", async () => {
    await withDocument(async (documentPath) => {
      await expect(readImageAsDataUrl({
        documentPath,
        source: "https://private.example/image.png",
        fetchImpl: vi.fn(),
        resolveHostname: async () => [{ address: "192.168.1.20", family: 4 }],
      })).rejects.toMatchObject({ code: "IMAGE_DOWNLOAD_FAILED" });

      await expect(readImageAsDataUrl({
        documentPath,
        source: "https://public.example/image.png",
        fetchImpl: vi.fn(async () => new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private.png" },
        })),
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
      })).rejects.toMatchObject({ code: "IMAGE_DOWNLOAD_FAILED" });

      await expect(readImageAsDataUrl({
        documentPath,
        source: "https://example.test/page",
        fetchImpl: vi.fn(async () => new Response("html", {
          status: 200,
          headers: { "content-type": "text/html" },
        })),
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
      })).rejects.toMatchObject({ code: "UNSUPPORTED_MIME" });

      await expect(readImageAsDataUrl({
        documentPath,
        source: "https://example.test/large.png",
        fetchImpl: vi.fn(async () => new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
          status: 200,
          headers: { "content-type": "image/png" },
        })),
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }],
      })).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    });
  });

  it("selects local images and saves pasted images under the assets directory", async () => {
    await withDocument(async (documentPath, root) => {
      const imagePath = path.join(root, "image.jpg");
      await writeFile(imagePath, JPEG_BYTES);
      const selected = await pickImage({ documentPath, selectPath: async () => imagePath });
      expect(selected).toEqual({
        sourcePath: imagePath,
        relativePath: "./image.jpg",
        dataUrl: `data:image/jpeg;base64,${JPEG_BYTES.toString("base64")}`,
      });
      await expect(pickImage({ documentPath })).rejects.toBeInstanceOf(ImageServiceError);

      const saved = await savePastedImage({ documentPath, dataUrl: PNG_DATA_URL, preferredName: "../危险 名称?.jpg" });
      expect(saved.filePath).toBe(path.join(root, "设计-文档.assets", "危险-名称.png"));
      expect(await readFile(saved.filePath, "base64")).toBe(PNG_BYTES.toString("base64"));
      const second = await savePastedImage({ documentPath, dataUrl: PNG_DATA_URL, preferredName: "危险 名称.png" });
      expect(second.filePath).toBe(path.join(root, "设计-文档.assets", "危险-名称-1.png"));
    });
  });
});
