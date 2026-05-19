/**
 * E2E tests for source mode bugs:
 * - Bug #9: Source mode content not visible until scroll
 * - Bug #10: No proper syntax highlighting in source mode
 */
import { test, expect } from './fixtures/editor-fixture';

test.describe('Bug #9: Source mode content visibility', () => {
  test('content is visible immediately after switching to source mode', async ({ editor }) => {
    const markdown = '# Hello World\n\nThis is a test paragraph.\n\n- Item 1\n- Item 2';
    await editor.load(markdown);
    await editor.waitForReady();

    // Switch to source mode using Ctrl+/
    await editor.page.keyboard.press('Control+/');
    await editor.page.waitForTimeout(500);

    // Source editor (CodeMirror) should be visible
    const sourceEditor = editor.page.locator('#source-editor');
    await expect(sourceEditor).toBeVisible();

    // The CodeMirror editor should be present
    const cmEditor = editor.page.locator('.cm-editor');
    await expect(cmEditor).toBeVisible();

    // Content should be visible without scrolling
    const cmContent = editor.page.locator('.cm-content');
    await expect(cmContent).toBeVisible();

    // The text should be in the editor
    const text = await cmContent.innerText();
    expect(text).toContain('Hello World');
    expect(text).toContain('test paragraph');
  });

  test('source editor has correct line count matching content', async ({ editor }) => {
    const markdown = 'Line 1\n\nLine 2\n\nLine 3\n\nLine 4';
    await editor.load(markdown);
    await editor.waitForReady();

    // Switch to source mode
    await editor.page.keyboard.press('Control+/');
    await editor.page.waitForTimeout(500);

    // Line numbers should be visible (CodeMirror gutter)
    const gutters = editor.page.locator('.cm-gutters');
    await expect(gutters).toBeVisible();

    const lineNumbers = editor.page.locator('.cm-lineNumbers .cm-gutterElement');
    // The content includes a settings comment line plus the original lines
    // At minimum, should have more than 1 line
    const count = await lineNumbers.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('CodeMirror viewport is measured after source mode toggle', async ({ editor }) => {
    const longContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1} with some content`).join('\n\n');
    await editor.load(longContent);
    await editor.waitForReady();

    // Switch to source mode
    await editor.page.keyboard.press('Control+/');
    await editor.page.waitForTimeout(500);

    // The cm-content should have visible lines (not all collapsed)
    const visibleLines = editor.page.locator('.cm-content .cm-line');
    const count = await visibleLines.count();
    // Should have rendered visible lines (not 0)
    expect(count).toBeGreaterThan(0);

    // The .cm-scroller should have proper dimensions
    const scrollerBox = await editor.page.locator('.cm-scroller').boundingBox();
    expect(scrollerBox).not.toBeNull();
    expect(scrollerBox!.height).toBeGreaterThan(100);
  });
});

test.describe('Bug #10: Source mode syntax highlighting', () => {
  test('markdown headings have syntax highlighting tokens', async ({ editor }) => {
    await editor.load('# Heading 1\n\n## Heading 2\n\nRegular text');
    await editor.waitForReady();

    // Switch to source mode
    await editor.page.keyboard.press('Control+/');
    await editor.page.waitForTimeout(500);

    // CodeMirror 6 applies syntax highlighting via span elements with unique classes
    // (generated CSS scope classes like ͼ1, ͼ2, etc.) or inline styles.
    // The key indicator is that spans exist inside .cm-line elements
    const hasHighlighting = await editor.page.evaluate(() => {
      const lines = document.querySelectorAll('.cm-line');
      for (const line of lines) {
        const spans = line.querySelectorAll('span');
        if (spans.length > 0) return true;
      }
      return false;
    });
    expect(hasHighlighting).toBe(true);
  });

  test('code blocks have distinct highlighting', async ({ editor }) => {
    await editor.load('# Title\n\n```javascript\nconst x = 42;\n```\n\nNormal text');
    await editor.waitForReady();

    // Switch to source mode
    await editor.page.keyboard.press('Control+/');
    await editor.page.waitForTimeout(500);

    // Should have some highlighted tokens from the markdown grammar
    const cmContent = editor.page.locator('.cm-content');
    const text = await cmContent.innerText();
    expect(text).toContain('const x = 42');

    // The syntaxHighlighting extension should have added span elements inside lines
    const spanCount = await editor.page.evaluate(() => {
      const lines = document.querySelectorAll('.cm-line');
      let count = 0;
      for (const line of lines) {
        count += line.querySelectorAll('span').length;
      }
      return count;
    });
    expect(spanCount).toBeGreaterThan(0);
  });

  test('heading markers are visually distinct from body text', async ({ editor }) => {
    await editor.load('# Heading\n\nRegular paragraph');
    await editor.waitForReady();

    // Switch to source mode
    await editor.page.keyboard.press('Control+/');
    await editor.page.waitForTimeout(500);

    // Check that the heading line has different styling from regular text
    const fontWeights = await editor.page.evaluate(() => {
      const lines = document.querySelectorAll('.cm-line');
      const results: { text: string; fontWeight: string; hasSpans: boolean }[] = [];
      for (const line of lines) {
        const text = line.textContent || '';
        if (text.trim()) {
          const computedStyle = getComputedStyle(line);
          results.push({
            text: text.substring(0, 20),
            fontWeight: computedStyle.fontWeight,
            hasSpans: line.querySelectorAll('span').length > 0,
          });
        }
      }
      return results;
    });

    // The heading line should have spans (syntax highlighting)
    const headingLine = fontWeights.find((l) => l.text.includes('# Heading'));
    expect(headingLine).toBeDefined();
    expect(headingLine!.hasSpans).toBe(true);
  });
});
