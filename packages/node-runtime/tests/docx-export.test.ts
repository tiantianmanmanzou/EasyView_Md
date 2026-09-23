/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { Packer } from 'docx';

import { markdownToDocx, writeDocxExport } from '../src/export/docx-export';

describe('markdownToDocx page orientation', () => {
  it('keeps a narrow table in the same portrait section as surrounding text', async () => {
    const document = await markdownToDocx(
      '前文\n\n| 字段 | 描述 |\n| --- | --- |\n| 名称 | 示例 |\n\n后文',
      'orientation-test',
      '/tmp',
    );
    const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
    const xml = await zip.file('word/document.xml')!.async('string');

    expect((xml.match(/<w:sectPr/g) ?? [])).toHaveLength(1);
    expect(xml).not.toMatch(/w:orient="landscape"/);
    expect(xml).toMatch(/<w:pgSz\b[^>]*w:orient="portrait"/);
  });

  it('keeps tables with fewer than 5 columns portrait even when cells are long', async () => {
    const longFields = Array.from({ length: 20 }, (_, i) => `field_name_${i}_very_long`).join(', ');
    const markdown = [
      '前文',
      '',
      '| 表名 | 说明 | 关键字段 |',
      '| --- | --- | --- |',
      `| orp_ops_ovw | 主数据/业务表 | ${longFields} |`,
      '',
      '后文',
    ].join('\n');
    const document = await markdownToDocx(markdown, 'three-col-portrait', '/tmp');
    const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
    const xml = await zip.file('word/document.xml')!.async('string');

    expect(xml).not.toMatch(/w:orient="landscape"/);
    expect((xml.match(/<w:sectPr/g) ?? [])).toHaveLength(1);
  });

  it('places only an over-wide table with 5+ columns in a landscape section', async () => {
    const wideCols = Array.from({ length: 8 }, (_, i) => `列${i + 1}很长内容ABCDEFGHIJKLMNOP`);
    const wideRow = wideCols.map((_, i) => `cell-${i}-long-unbroken-path-/api/orp/vio/detect/status/detail`);
    const markdown = [
      '前文',
      '',
      `| ${wideCols.join(' | ')} |`,
      `| ${wideCols.map(() => '---').join(' | ')} |`,
      `| ${wideRow.join(' | ')} |`,
      '',
      '后文',
    ].join('\n');
    const document = await markdownToDocx(markdown, 'wide-orientation-test', '/tmp');
    const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
    const xml = await zip.file('word/document.xml')!.async('string');

    expect((xml.match(/<w:sectPr/g) ?? [])).toHaveLength(3);
    expect((xml.match(/<w:pgSz\b[^>]*w:orient="landscape"/g) ?? [])).toHaveLength(1);
    expect((xml.match(/<w:pgSz\b[^>]*w:orient="portrait"/g) ?? [])).toHaveLength(2);
    expect(xml).toMatch(/<w:pgSz w:w="16837" w:h="11905" w:orient="landscape"\/>/);
  });
});


describe('DOCX image input security', () => {
  it('rejects parent traversal and absolute local image paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easyview-docx-'));
    const outside = path.join(path.dirname(root), 'easyview-secret.png');
    await writeFile(outside, Buffer.from([137, 80, 78, 71]));
    try {
      const document = await markdownToDocx(
        `![parent](../${path.basename(outside)})\n\n![absolute](${outside})`,
        'security-test',
        root,
      );
      const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
      const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
      expect(mediaFiles).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('rejects local images larger than 20MB', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easyview-docx-'));
    const imagePath = path.join(root, 'large.png');
    try {
      await writeFile(imagePath, Buffer.alloc(20 * 1024 * 1024 + 1));
      const document = await markdownToDocx('![large](large.png)', 'large-test', root);
      const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
      expect(Object.keys(zip.files).filter((name) => name.startsWith('word/media/'))).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects remote non-image content types', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not an image');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('server did not bind');
      const document = await markdownToDocx(
        `![remote](http://127.0.0.1:${address.port}/image)`,
        'remote-security-test',
        '/tmp',
      );
      const zip = await JSZip.loadAsync(await Packer.toBuffer(document));
      expect(Object.keys(zip.files).filter((name) => name.startsWith('word/media/'))).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('writes DOCX output through the atomic writer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easyview-docx-'));
    try {
      const targetPath = path.join(root, 'out', 'note.docx');
      const result = await writeDocxExport({ targetPath, markdown: '# 标题', title: 'note', docDir: root });
      expect(result.filePath).toBe(targetPath);
      expect(result.byteLength).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
