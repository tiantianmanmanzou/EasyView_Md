/**
 * Playwright fixtures for InLineMd E2E tests.
 *
 * Provides helpers for loading markdown content into the ProseMirror editor,
 * interacting with it, and asserting on results.
 */
import { test as base, expect, type Page, type Locator } from '@playwright/test';

/**
 * Page object for the ProseMirror WYSIWYG editor.
 */
export class EditorPage {
  readonly page: Page;
  readonly editorContainer: Locator;
  readonly prosemirror: Locator;
  readonly sourceEditor: Locator;

  constructor(page: Page) {
    this.page = page;
    this.editorContainer = page.locator('#editor');
    this.prosemirror = page.locator('.ProseMirror');
    this.sourceEditor = page.locator('.cm-editor');
  }

  /**
   * Navigate to the test harness with the given markdown content.
   * Waits for ProseMirror to be ready.
   */
  async load(markdown: string) {
    const url = `/?md=${encodeURIComponent(markdown)}`;
    await this.page.goto(url);
    // Wait for the ProseMirror editor to render
    await this.prosemirror.waitFor({ state: 'attached', timeout: 10_000 });
    // Give extensions a moment to initialize
    await this.page.waitForTimeout(300);
  }

  /**
   * Get the current markdown content from the editor via serialization.
   */
  async getMarkdown(): Promise<string> {
    return await this.page.evaluate(() => {
      // Access the editor core through the global test API
      const w = window as any;
      if (w.__editorCore) {
        return w.__editorCore.getMarkdown();
      }
      // Fallback: get messages sent to VS Code
      const msgs = w.__vscodeMessages || [];
      const updateMsg = msgs.filter((m: any) => m.type === 'update').pop();
      return updateMsg?.text || '';
    });
  }

  /**
   * Get inner text of the ProseMirror editor.
   */
  async getEditorText(): Promise<string> {
    return await this.prosemirror.innerText();
  }

  /**
   * Click at a position within the editor.
   */
  async clickEditor(options?: { position?: { x: number; y: number } }) {
    if (options?.position) {
      await this.prosemirror.click({ position: options.position });
    } else {
      await this.prosemirror.click();
    }
  }

  /**
   * Type text into the focused editor.
   */
  async type(text: string) {
    await this.page.keyboard.type(text);
  }

  /**
   * Press a key or key combination (e.g., 'Enter', 'Control+z').
   */
  async press(key: string) {
    await this.page.keyboard.press(key);
  }

  /**
   * Toggle source mode using the keyboard shortcut or button.
   */
  async toggleSourceMode() {
    // The source mode toggle is typically a button in the UI
    const toggle = this.page.locator('[data-testid="source-mode-toggle"], .source-mode-toggle, button:has-text("Source")');
    if (await toggle.count() > 0) {
      await toggle.first().click();
    } else {
      // Try keyboard shortcut
      await this.page.keyboard.press('Control+Shift+M');
    }
    await this.page.waitForTimeout(200);
  }

  /**
   * Wait for the editor to be fully initialized.
   */
  async waitForReady() {
    await this.prosemirror.waitFor({ state: 'visible', timeout: 10_000 });
    // Ensure content has been loaded (has at least one child node)
    await this.page.waitForFunction(
      () => {
        const pm = document.querySelector('.ProseMirror');
        return pm && pm.childElementCount > 0;
      },
      { timeout: 10_000 }
    );
  }

  /**
   * Get a specific block element by type and optional content.
   */
  getBlock(selector: string): Locator {
    return this.prosemirror.locator(selector);
  }

  /**
   * Get bounding rect of an element.
   */
  async getBoundingRect(locator: Locator) {
    return await locator.boundingBox();
  }
}

/**
 * Extended test fixture with EditorPage.
 */
export const test = base.extend<{ editor: EditorPage }>({
  editor: async ({ page }, use) => {
    const editor = new EditorPage(page);
    await use(editor);
  },
});

export { expect };
