/**
 * Smoke test — verifies the E2E test infrastructure works.
 * Loads the editor with basic markdown and checks it renders.
 */
import { test, expect } from './fixtures/editor-fixture';

test.describe('E2E Infrastructure', () => {
  test('editor loads and renders markdown content', async ({ editor }) => {
    await editor.load('# Hello World\n\nThis is a test paragraph.');
    await editor.waitForReady();

    // ProseMirror editor should be visible
    await expect(editor.prosemirror).toBeVisible();

    // Should contain the heading text
    const text = await editor.getEditorText();
    expect(text).toContain('Hello World');
    expect(text).toContain('This is a test paragraph');
  });

  test('editor renders bold and italic', async ({ editor }) => {
    await editor.load('**bold text** and *italic text*');
    await editor.waitForReady();

    // Check that strong/em elements exist in ProseMirror
    const strong = editor.prosemirror.locator('strong');
    const em = editor.prosemirror.locator('em');

    await expect(strong).toHaveText('bold text');
    await expect(em).toHaveText('italic text');
  });

  test('editor renders lists', async ({ editor }) => {
    await editor.load('- Item 1\n- Item 2\n- Item 3');
    await editor.waitForReady();

    const items = editor.prosemirror.locator('li');
    await expect(items).toHaveCount(3);
  });
});
