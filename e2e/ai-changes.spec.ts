/**
 * E2E tests for Bug #5: AI-edited block shifts sideways during animation.
 *
 * Verifies:
 * - Adding `block-ai-active` class doesn't shift block position/width
 * - Shimmer animation uses absolute positioning (no layout shift)
 * - Modified/added highlight classes preserve block geometry
 */
import { test, expect } from './fixtures/editor-fixture';

test.describe('Bug #5: AI block animation layout stability', () => {
  test('block-ai-active class does not shift block horizontally', async ({ editor }) => {
    await editor.load('# Heading\n\nSome paragraph text here.\n\nAnother paragraph.');
    await editor.waitForReady();

    // Get initial bounding rects of paragraphs
    const paragraphs = editor.prosemirror.locator('p');
    const initialRects = await paragraphs.evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, width: rect.width, top: rect.top };
      })
    );

    expect(initialRects.length).toBeGreaterThanOrEqual(2);

    // Add block-ai-active class to all paragraphs (simulating AI active state)
    await editor.page.evaluate(() => {
      document.querySelectorAll('.ProseMirror > p').forEach((el) => {
        el.classList.add('block-ai-active');
      });
    });

    // Wait a frame for CSS to apply
    await editor.page.waitForTimeout(100);

    // Get rects after adding animation class
    const afterRects = await paragraphs.evaluateAll((elements) =>
      elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, width: rect.width, top: rect.top };
      })
    );

    // Verify no horizontal shift — left position should stay the same
    for (let i = 0; i < Math.min(initialRects.length, afterRects.length); i++) {
      expect(afterRects[i].left).toBeCloseTo(initialRects[i].left, 0);
      // Width may change slightly due to overflow:hidden but should be similar
      expect(Math.abs(afterRects[i].width - initialRects[i].width)).toBeLessThan(5);
    }
  });

  test('block-ai-modified CSS uses non-disruptive styling', async ({ editor }) => {
    await editor.load('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
    await editor.waitForReady();

    // Verify the CSS rules for .block-ai-modified are loaded and correct
    const cssText = await editor.page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule && rule.selectorText === '.block-ai-modified') {
              return rule.cssText;
            }
          }
        } catch (e) { /* cross-origin */ }
      }
      return null;
    });

    expect(cssText).not.toBeNull();
    // Uses box-shadow inset instead of border-left — zero layout impact
    expect(cssText).toContain('box-shadow');
    expect(cssText).toContain('inset');
    expect(cssText).toContain('3px');
    // Background gradient for visual indicator
    expect(cssText).toContain('gradient');
    // No padding-left, margin-left, or border-left — no layout shift
    expect(cssText).not.toContain('padding-left');
    expect(cssText).not.toContain('margin-left');
    expect(cssText).not.toContain('border-left');
  });

  test('shimmer CSS uses absolute positioning for pseudo-element', async ({ editor }) => {
    await editor.load('Test paragraph for shimmer.');
    await editor.waitForReady();

    // Verify the CSS rules for .block-ai-active and ::before
    const styles = await editor.page.evaluate(() => {
      const testDiv = document.createElement('div');
      testDiv.className = 'block-ai-active';
      testDiv.textContent = 'test';
      testDiv.style.width = '200px';
      testDiv.style.height = '40px';
      document.body.appendChild(testDiv);

      const elStyle = getComputedStyle(testDiv);
      const pseudoStyle = getComputedStyle(testDiv, '::before');
      const result = {
        position: elStyle.position,
        overflow: elStyle.overflow,
        pseudoPosition: pseudoStyle.position,
        pseudoPointerEvents: pseudoStyle.pointerEvents,
      };
      testDiv.remove();
      return result;
    });

    // .block-ai-active should be position: relative with overflow: hidden
    expect(styles.position).toBe('relative');
    expect(styles.overflow).toBe('hidden');
    // ::before should be absolute positioned and not intercept clicks
    expect(styles.pseudoPosition).toBe('absolute');
    expect(styles.pseudoPointerEvents).toBe('none');
  });
});
