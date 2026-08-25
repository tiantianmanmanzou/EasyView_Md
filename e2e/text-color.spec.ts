import { test, expect } from './fixtures/editor-fixture';

test('text color popover stays next to the toolbar, applies a color, and toggles it off', async ({ editor, page }) => {
  await editor.load('颜色测试文本');
  await editor.waitForReady();

  await page.locator('.ProseMirror p').selectText();
  const toolbar = page.locator('.floating-toolbar.visible');
  const colorButton = toolbar.locator('button[data-command="text-color"]');
  const buttonBox = await colorButton.boundingBox();
  expect(buttonBox).not.toBeNull();

  await colorButton.click();
  const popover = page.locator('.easyview-text-color-popover');
  await expect(popover).toBeVisible();
  const popoverBox = await popover.boundingBox();
  expect(popoverBox).not.toBeNull();
  expect(Math.abs(popoverBox!.x - buttonBox!.x)).toBeLessThanOrEqual(4);

  await popover.locator('button[aria-label="Set text color #2563eb"]').click();
  await expect(page.locator('.ProseMirror span[style*="color"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror span[style*="color"]')).toHaveAttribute('style', /#2563eb|rgb\(37, 99, 235\)/);

  await page.locator('.ProseMirror p').selectText();
  await colorButton.click();
  await expect(page.locator('.ProseMirror span[style*="color"]')).toHaveCount(0);
});
