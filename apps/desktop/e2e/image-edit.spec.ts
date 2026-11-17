import { expect, test, type Page } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchPreviewWorkspace, previewFixtures } from './support/previewWorkspace';

const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

/** Pixels of `edited` at `points`, and of `original` at the spots a clockwise quarter turn moves there. */
function turnedPixels(page: Page, original: Buffer, edited: Buffer, points: Array<[number, number]>) {
  return page.evaluate(async ({ original, edited, points }) => {
    const decode = async (base64: string) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return { height: bitmap.height, pixel: (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data].join(',') };
    };
    const before = await decode(original), after = await decode(edited);
    return points.map(([x, y]) => [after.pixel(x, y), before.pixel(y, before.height - 1 - x)]);
  }, { original: original.toString('base64'), edited: edited.toString('base64'), points });
}

test('image toolbar rotates and crops a png, saves over the file and shows the result', async () => {
  const ws = await launchPreviewWorkspace();
  try {
    const { page } = ws; const file = path.join(ws.workspace, 'sample.png');
    const original = await readFile(file);
    await ws.open('sample.png');
    const root = page.locator('#file-preview-root');
    const save = root.getByRole('button', { name: '保存', exact: true }), discard = root.getByRole('button', { name: '放弃修改', exact: true });
    await expect(save).toBeDisabled(); await expect(discard).toBeDisabled();
    // Editing happens on the preview itself: the viewer turns its own picture, no separate stage.
    const frame = root.locator('.image-stage .image-frame'), picture = frame.locator('img');
    await expect(picture).toBeVisible();
    const landscape = (await frame.boundingBox())!;
    await root.getByRole('button', { name: '向右旋转', exact: true }).click();
    await expect(save).toBeEnabled();
    await expect.poll(async () => { const box = (await frame.boundingBox())!; return box.height > box.width; }).toBe(true); // 480×240 turned clockwise is portrait
    const box = (await frame.boundingBox())!;
    expect(Math.round(box.height)).toBe(Math.round(landscape.width)); // same zoom, just turned
    await expect(picture).toBeVisible();

    // Crop on the shown picture, then drag the bottom-right handle up-left by a quarter of it.
    await root.getByRole('button', { name: '裁剪', exact: true }).click();
    const crop = frame.locator('.preview-image-crop'), size = crop.locator('.preview-image-crop-size');
    await expect(size).toHaveText('192 × 384');
    const handle = (await crop.locator('[data-handle="se"]').boundingBox())!;
    await page.mouse.move(handle.x + 5, handle.y + 5); await page.mouse.down();
    await page.mouse.move(handle.x + 5 - box.width / 4, handle.y + 5 - box.height / 4, { steps: 5 }); await page.mouse.up();
    await expect(size).not.toHaveText('192 × 384');
    const [width, height] = (await size.textContent())!.split(' × ').map(Number);
    expect(width).toBeGreaterThan(120); expect(width).toBeLessThan(144);

    await save.click();
    await expect(crop).toHaveCount(0);
    await expect.poll(async () => pngSize(await readFile(file))).toEqual({ width, height });
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => `${img.naturalWidth}×${img.naturalHeight}`)).toBe(`${width}×${height}`);
    await expect(save).toBeDisabled();

    // Turning the saved picture and discarding turns it back and leaves the file alone.
    const saved = await readFile(file);
    const upright = (await frame.boundingBox())!;
    await root.getByRole('button', { name: '向左旋转', exact: true }).click();
    await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(Math.round(upright.height));
    await discard.click();
    await expect.poll(async () => Math.round((await frame.boundingBox())!.width)).toBe(Math.round(upright.width));
    await expect(discard).toBeDisabled();
    expect((await readFile(file)).equals(saved)).toBe(true);

    // A plain quarter turn moves every pixel exactly.
    copyFileSync(path.join(previewFixtures, 'sample.png'), file);
    await page.evaluate(() => (window as any).easyViewDesktop.tabs.openWorkspaceEntry('notes.md'));
    await ws.open('sample.png');
    await root.getByRole('button', { name: '向右旋转', exact: true }).click();
    await save.click();
    await expect.poll(async () => pngSize(await readFile(file))).toEqual({ width: 240, height: 480 });
    for (const [after, before] of await turnedPixels(page, original, await readFile(file), [[0, 0], [10, 300], [239, 479], [120, 60]])) expect(after).toBe(before);
  } finally { await ws.dispose(); }
});
