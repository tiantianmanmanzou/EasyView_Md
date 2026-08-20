/**
 * Nested table horizontal scroll must stay put, and scrolling must not rebuild
 * column-control DOM (that janks the page and resets scrollLeft).
 */
import { test, expect } from './fixtures/editor-fixture';

const WIDE = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';

const nestedQingdanMarkdown = `<table>
<tr><th>功能清单</th><th>需求来源</th></tr>
<tr><td>
<table>
<tr>
<td data-colwidth="120">二级功能</td>
<td data-colwidth="180">三级功能</td>
<td data-colwidth="520">功能描述</td>
</tr>
<tr>
<td data-colwidth="120">数据资源画像</td>
<td data-colwidth="180">连接信息展示</td>
<td data-colwidth="520">${WIDE}展示数据资源资产识别的连接信息</td>
</tr>
</table>
</td><td>上级单位考核</td></tr>
</table>`;

test.describe('Nested 功能清单 table scroll', () => {
  test.beforeEach(async ({ editor, page }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({
      content: `
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable {
          max-width: 420px !important;
        }
        .ProseMirror table.table-manual-width {
          width: 820px !important;
          min-width: 820px !important;
        }
      `,
    });
  });

  test('scrolling a nested table does not rebuild column controls', async ({ page }) => {
    const nested = page.locator('.ProseMirror td .table-wrapper .table-scrollable').first();
    await expect(nested).toBeVisible();

    const result = await nested.evaluate((el: HTMLElement) => {
      (window as any).__rebuilds = 0;
      const mo = new MutationObserver((records: MutationRecord[]) => {
        for (const record of records) {
          if (
            record.target instanceof HTMLElement &&
            record.target.classList.contains('table-column-controls') &&
            record.type === 'childList'
          ) {
            (window as any).__rebuilds++;
          }
        }
      });
      mo.observe(document.querySelector('.ProseMirror')!, { childList: true, subtree: true });
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      const snapshot = {
        rebuilds: (window as any).__rebuilds as number,
        scrollLeft: el.scrollLeft,
        overflow: el.scrollWidth - el.clientWidth,
      };
      mo.disconnect();
      return snapshot;
    });

    expect(result.overflow).toBeGreaterThan(40);
    expect(result.scrollLeft).toBeGreaterThan(40);
    expect(result.rebuilds).toBe(0);
  });

  test('hovering a nested column edge does not reset scrollLeft before dragging', async ({ page }) => {
    const nested = page.locator('.ProseMirror td .table-wrapper .table-scrollable').first();
    await expect(nested).toBeVisible();

    const targetScroll = await nested.evaluate((element: HTMLElement) => {
      element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      return element.scrollLeft;
    });
    expect(targetScroll).toBeGreaterThan(40);

    const lastCell = nested.locator('tr:first-child td:last-child').first();
    const edge = await lastCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 3, y: rect.top + Math.min(14, rect.height / 2) };
    });
    await page.evaluate(() => {
      const outer = document.querySelector('.ProseMirror > .table-wrapper table') as HTMLTableElement;
      const state = { colWidthWrites: 0 };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes' && record.target instanceof HTMLTableColElement) {
            state.colWidthWrites++;
          }
        }
      });
      observer.observe(outer, { attributes: true, attributeFilter: ['style'], subtree: true });
      (window as any).__nestedHoverObserver = observer;
      (window as any).__nestedHoverState = state;
    });
    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(100);

    const afterHover = await nested.evaluate((element: HTMLElement) => element.scrollLeft);
    const hoverStats = await page.evaluate(() => {
      ((window as any).__nestedHoverObserver as MutationObserver).disconnect();
      return (window as any).__nestedHoverState as { colWidthWrites: number };
    });
    expect(afterHover).toBeGreaterThan(targetScroll - 2);
    // The outer table must not reapply its colgroup during a nested-handle
    // hover; that width rewrite is what used to clamp this scrollport to zero.
    expect(hoverStats.colWidthWrites).toBe(0);
  });

  test('moving the pointer on the last nested column keeps scrollLeft', async ({ page }) => {
    const nested = page.locator('.ProseMirror td .table-wrapper .table-scrollable').first();
    await expect(nested).toBeVisible();

    const targetScroll = await nested.evaluate((el: HTMLElement) => {
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      return el.scrollLeft;
    });
    expect(targetScroll).toBeGreaterThan(40);

    const lastCell = nested.locator('tr:first-child td:last-child').first();
    const edge = await lastCell.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.right - 3, y: rect.top + Math.min(14, rect.height / 2) };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    for (const dx of [8, 18, 30, 42, 20]) {
      await page.mouse.move(edge.x + dx, edge.y);
      await page.waitForTimeout(30);
    }
    const midScroll = await nested.evaluate((el: HTMLElement) => el.scrollLeft);
    await page.mouse.up();
    await page.waitForTimeout(80);
    const afterScroll = await nested.evaluate((el: HTMLElement) => el.scrollLeft);

    expect(midScroll).toBeGreaterThan(targetScroll - 50);
    expect(afterScroll).toBeGreaterThan(targetScroll - 50);
  });

  test('double-clicking a nested column divider compacts only that column and preserves scroll', async ({ page }) => {
    const nested = page.locator('.ProseMirror td .table-wrapper .table-scrollable').first();
    await expect(nested).toBeVisible();

    const targetScroll = await nested.evaluate((element: HTMLElement) => {
      element.scrollLeft = Math.min(80, Math.max(0, element.scrollWidth - element.clientWidth));
      return element.scrollLeft;
    });
    expect(targetScroll).toBeGreaterThan(20);

    const firstCell = nested.locator('tr:first-child td').first();
    const edge = await firstCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 3, y: rect.top + Math.min(14, rect.height / 2) };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.dblclick(edge.x, edge.y);
    await page.waitForTimeout(180);

    const result = await nested.evaluate((element: HTMLElement) => ({
      scrollLeft: element.scrollLeft,
      widths: Array.from(element.querySelectorAll('tr:first-child td')).map((cell) =>
        (cell as HTMLElement).getBoundingClientRect().width
      ),
    }));

    expect(result.widths[0]).toBeGreaterThanOrEqual(96);
    expect(result.widths[0]).toBeLessThanOrEqual(104);
    // This fixture pins the rendered table width at 820px, so CSS distributes
    // spare pixels across cells. Verify the persisted colgroup instead: only
    // the selected column may change; the other two must retain their widths.
    const colWidths = await nested.locator('colgroup col').evaluateAll((columns) =>
      columns.map((column) => Number.parseFloat((column as HTMLElement).style.width))
    );
    expect(colWidths).toEqual([100, 180, 520]);
    expect(result.scrollLeft).toBeGreaterThan(targetScroll - 4);
  });
});

test.describe('Outer table wheel while hovering a nested table', () => {
  test('horizontal wheel over a nested table with a scrollbar pans the nested table first', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({
      content: `
        #editor.table-wrap .ProseMirror > .table-wrapper > .table-scrollable {
          max-width: 360px !important;
        }
        #editor.table-wrap .ProseMirror > .table-wrapper table {
          width: 920px !important;
          min-width: 920px !important;
          table-layout: fixed !important;
        }
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable {
          max-width: 280px !important;
        }
      `,
    });

    const nestedCell = page.locator('.ProseMirror td .table-wrapper table td').first();
    await expect(nestedCell).toBeVisible();

    const before = await page.evaluate(() => {
      const outerScroll = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      const nestedScroll = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      return {
        outerOverflow: outerScroll.scrollWidth - outerScroll.clientWidth,
        nestedOverflow: nestedScroll.scrollWidth - nestedScroll.clientWidth,
      };
    });
    expect(before.outerOverflow).toBeGreaterThan(40);
    expect(before.nestedOverflow).toBeGreaterThan(40);

    const after = await nestedCell.evaluate((el) => {
      const ev = new WheelEvent('wheel', { deltaX: 120, deltaY: 0, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      const outerScroll = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      const nestedScroll = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      return {
        outerLeft: outerScroll.scrollLeft,
        nestedLeft: nestedScroll.scrollLeft,
      };
    });
    expect(after.nestedLeft).toBeGreaterThan(20);
    expect(after.outerLeft).toBeLessThanOrEqual(2);
  });

  test('horizontal wheel still scrolls a nested table when the outer table cannot pan', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({
      content: `
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable {
          max-width: 280px !important;
        }
      `,
    });

    const nestedCell = page.locator('.ProseMirror td .table-wrapper table td').first();
    await expect(nestedCell).toBeVisible();

    const before = await page.evaluate(() => {
      const outerScroll = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      const nestedScroll = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      return {
        outerOverflow: outerScroll.scrollWidth - outerScroll.clientWidth,
        nestedOverflow: nestedScroll.scrollWidth - nestedScroll.clientWidth,
        nestedLeft: nestedScroll.scrollLeft,
      };
    });
    expect(before.nestedOverflow).toBeGreaterThan(40);

    const box = await nestedCell.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('Expected a nested table cell');
    await page.mouse.move(box.x + Math.min(24, box.width / 2), box.y + Math.min(16, box.height / 2));
    await page.mouse.wheel(120, 0);
    await page.waitForTimeout(80);

    const nestedLeft = await page.locator('.ProseMirror td .table-wrapper > .table-scrollable').first()
      .evaluate((el: HTMLElement) => el.scrollLeft);
    expect(nestedLeft).toBeGreaterThan(before.nestedLeft + 20);
  });

  test('horizontal wheel chains to the outer table after the nested table hits an edge', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({
      content: `
        #editor.table-wrap .ProseMirror > .table-wrapper > .table-scrollable {
          max-width: 360px !important;
        }
        #editor.table-wrap .ProseMirror > .table-wrapper table {
          width: 920px !important;
          min-width: 920px !important;
          table-layout: fixed !important;
        }
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable {
          max-width: 280px !important;
        }
      `,
    });

    const nestedCell = page.locator('.ProseMirror td .table-wrapper table td').first();
    await expect(nestedCell).toBeVisible();

    const after = await nestedCell.evaluate((el) => {
      const nestedScroll = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      const outerScroll = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      nestedScroll.scrollLeft = Math.max(0, nestedScroll.scrollWidth - nestedScroll.clientWidth);
      const nestedMax = nestedScroll.scrollLeft;
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: 160, deltaY: 0, bubbles: true, cancelable: true }));
      const afterRight = {
        nestedLeft: nestedScroll.scrollLeft,
        outerLeft: outerScroll.scrollLeft,
      };
      outerScroll.scrollLeft = Math.max(0, outerScroll.scrollWidth - outerScroll.clientWidth);
      nestedScroll.scrollLeft = 0;
      const outerMax = outerScroll.scrollLeft;
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: -160, deltaY: 0, bubbles: true, cancelable: true }));
      return {
        nestedMax,
        outerOverflow: outerScroll.scrollWidth - outerScroll.clientWidth,
        afterRight,
        afterLeft: {
          nestedLeft: nestedScroll.scrollLeft,
          outerLeft: outerScroll.scrollLeft,
          outerMax,
        },
      };
    });

    expect(after.outerOverflow).toBeGreaterThan(40);
    expect(after.afterRight.nestedLeft).toBeGreaterThanOrEqual(after.nestedMax - 1);
    expect(after.afterRight.outerLeft).toBeGreaterThan(20);
    expect(after.afterLeft.nestedLeft).toBeLessThanOrEqual(1);
    expect(after.afterLeft.outerLeft).toBeLessThan(after.afterLeft.outerMax - 20);
  });
});



const implicitWidthTableMarkdown = `<table>
<tr><th>功能描述及处理说明</th><th>传输方式</th><th>传输频率</th><th>数据格式</th></tr>
<tr><td>${WIDE}接口有效时间、接口 URL、关键输入参数、返回数据处理说明</td><td>Kafka</td><td>每月（月初）</td><td>json</td></tr>
</table>`;

const outerTableMarkdown = `<table>
<tr>
<th data-colwidth="160">列A</th>
<th data-colwidth="160">列B</th>
<th data-colwidth="160">列C</th>
</tr>
<tr>
<td data-colwidth="160">1</td>
<td data-colwidth="160">2</td>
<td data-colwidth="160">3</td>
</tr>
<tr>
<td data-colwidth="160">4</td>
<td data-colwidth="160">5</td>
<td data-colwidth="160">6</td>
</tr>
</table>`;

test.describe('Table column resize flicker', () => {
  test('resizing one implicit-width column preserves the other rendered column widths', async ({
    editor,
    page,
  }) => {
    await editor.load(implicitWidthTableMarkdown);
    await editor.waitForReady();

    const cells = page.locator('.ProseMirror > .table-wrapper table tr:first-child th');
    await expect(cells).toHaveCount(4);
    const beforeWidths = await cells.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width)
    );
    expect(beforeWidths.slice(1).every((width) => width > 50)).toBe(true);

    const firstCell = cells.first();
    const edge = await firstCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + Math.min(16, rect.height / 2) };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(edge.x + 56, edge.y);
    await page.mouse.up();
    await page.waitForTimeout(120);

    const afterWidths = await cells.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width)
    );
    expect(Math.abs(afterWidths[0] - beforeWidths[0])).toBeGreaterThan(24);
    // Regression: prosemirror-tables persists only the resized column. The
    // remaining columns must retain their rendered width instead of 32px.
    expect(afterWidths.slice(1).every((width) => width > 50)).toBe(true);
  });

  test('double-clicking a column divider compacts only that column', async ({ editor, page }) => {
    await editor.load(outerTableMarkdown);
    await editor.waitForReady();

    const cells = page.locator('.ProseMirror > .table-wrapper table tr:first-child th');
    const before = await cells.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    const firstCell = cells.first();
    const edge = await firstCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + Math.min(16, rect.height / 2) };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.dblclick(edge.x, edge.y);
    await page.waitForTimeout(180);

    const after = await cells.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    expect(after[0]).toBeGreaterThanOrEqual(96);
    expect(after[0]).toBeLessThanOrEqual(104);
    expect(Math.abs(after[1] - before[1])).toBeLessThan(3);
    expect(Math.abs(after[2] - before[2])).toBeLessThan(3);
  });

  test('resizing an outer table column does not class-toggle the editor root', async ({
    editor,
    page,
  }) => {
    await editor.load(outerTableMarkdown);
    await editor.waitForReady();

    const firstCell = page.locator('.ProseMirror .table-wrapper table tr:first-child th, .ProseMirror .table-wrapper table tr:first-child td').first();
    await expect(firstCell).toBeVisible();
    const before = await firstCell.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        width: rect.width,
        x: rect.right - 2,
        y: rect.top + Math.min(16, rect.height / 2),
      };
    });

    const stats = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      const state = {
        rootResizeCursor: 0,
        rootClassMutations: 0,
        controlRebuilds: 0,
      };
      const mo = new MutationObserver((records) => {
        for (const record of records) {
          if (record.target === pm && record.type === 'attributes' && record.attributeName === 'class') {
            state.rootClassMutations++;
            if (pm.classList.contains('resize-cursor')) state.rootResizeCursor++;
          }
          if (
            record.target instanceof HTMLElement &&
            record.target.classList.contains('table-column-controls') &&
            record.type === 'childList'
          ) {
            state.controlRebuilds++;
          }
        }
      });
      mo.observe(pm, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
      (window as any).__flickerMo = mo;
      (window as any).__flickerStats = state;
    });
    void stats;

    await page.mouse.move(before.x, before.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    for (const dx of [12, 28, 44, 24]) {
      await page.mouse.move(before.x + dx, before.y);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(80);

    const result = await page.evaluate(() => {
      const mo = (window as any).__flickerMo as MutationObserver;
      mo.disconnect();
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      const stats = (window as any).__flickerStats as {
        rootResizeCursor: number;
        rootClassMutations: number;
        controlRebuilds: number;
      };
      return {
        ...stats,
        rootHasResizeCursor: pm.classList.contains('resize-cursor'),
        tableHasResizeCursor: Boolean(document.querySelector('.table-wrapper.easyview-col-resize-cursor')),
      };
    });

    const afterWidth = await firstCell.evaluate((el) => el.getBoundingClientRect().width);

    expect(result.rootHasResizeCursor).toBe(false);
    expect(result.rootResizeCursor).toBe(0);
    expect(result.controlRebuilds).toBe(0);
    expect(afterWidth).toBeGreaterThan(before.width + 8);
  });

  test('resizing a nested table column does not class-toggle the editor root', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({
      content: `
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable {
          max-width: 420px !important;
        }
      `,
    });

    const nestedCell = page.locator('.ProseMirror td .table-wrapper table tr:first-child td').first();
    await expect(nestedCell).toBeVisible();
    const edge = await nestedCell.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + Math.min(16, rect.height / 2) };
    });

    await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      const state = { rootResizeCursor: 0 };
      const mo = new MutationObserver(() => {
        if (pm.classList.contains('resize-cursor')) state.rootResizeCursor++;
      });
      mo.observe(pm, { attributes: true, attributeFilter: ['class'] });
      (window as any).__nestedFlickerMo = mo;
      (window as any).__nestedFlickerStats = state;
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(edge.x + 24, edge.y);
    await page.waitForTimeout(40);

    const activeCursorOwners = await page.evaluate(() => ({
      outer: Boolean(document.querySelector('.ProseMirror > .table-wrapper.easyview-col-resize-cursor')),
      nested: Boolean(document.querySelector('.ProseMirror td .table-wrapper.easyview-col-resize-cursor')),
    }));

    await page.mouse.up();

    const result = await page.evaluate(() => {
      ((window as any).__nestedFlickerMo as MutationObserver).disconnect();
      const pm = document.querySelector('.ProseMirror') as HTMLElement;
      return {
        rootResizeCursor: (window as any).__nestedFlickerStats.rootResizeCursor as number,
        rootHasResizeCursor: pm.classList.contains('resize-cursor'),
      };
    });

    expect(result.rootHasResizeCursor).toBe(false);
    expect(result.rootResizeCursor).toBe(0);
    expect(activeCursorOwners.outer).toBe(false);
    expect(activeCursorOwners.nested).toBe(true);
  });

  test('resizing a nested table column does not lock a tall empty host row', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();

    const lastNestedCell = page.locator('.ProseMirror td .table-wrapper table tr:last-child td').last();
    await expect(lastNestedCell).toBeVisible();
    const edge = await lastNestedCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.bottom - 2 };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(edge.x + 80, edge.y + 36, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(160);

    const result = await page.evaluate(() => {
      const outerCell = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr:last-child > td',
      ) as HTMLElement;
      const nestedWrapper = document.querySelector('.ProseMirror td .table-wrapper') as HTMLElement;
      const nestedTable = nestedWrapper.querySelector(':scope > .table-scrollable > table') as HTMLElement;
      return {
        outerRowResized: Boolean(outerCell?.hasAttribute('data-easyview-row-resized')),
        nestedResizedRows: nestedWrapper.querySelectorAll('[data-easyview-row-resized]').length,
        outerCellHeight: outerCell.getBoundingClientRect().height,
        nestedTableHeight: nestedTable.getBoundingClientRect().height,
      };
    });

    expect(result.outerRowResized).toBe(false);
    expect(result.nestedResizedRows).toBe(0);
    expect(result.outerCellHeight).toBeLessThan(result.nestedTableHeight + 120);
  });
});

test.describe('Outer column resize is independent of nested table width', () => {
  test('dragging a host column narrower than its nested table scrolls the nested table', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();

    const headerCell = page.locator('.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr:first-child > th').first();
    await expect(headerCell).toBeVisible();

    const before = await page.evaluate(() => {
      const cell = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr:last-child > td',
      ) as HTMLElement;
      const nested = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable > table',
      ) as HTMLTableElement;
      return {
        cellWidth: cell.getBoundingClientRect().width,
        nestedWidth: nested.getBoundingClientRect().width,
      };
    });
    expect(before.nestedWidth).toBeGreaterThan(600);

    const edge = await headerCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + Math.min(16, rect.height / 2) };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(edge.x - 360, edge.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(160);

    const after = await page.evaluate(() => {
      const cell = document.querySelector(
        '.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr:last-child > td',
      ) as HTMLElement;
      const nested = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable > table',
      ) as HTMLTableElement;
      const scrollable = document.querySelector(
        '.ProseMirror td .table-wrapper > .table-scrollable',
      ) as HTMLElement;
      return {
        cellWidth: cell.getBoundingClientRect().width,
        nestedWidth: nested.getBoundingClientRect().width,
        overflow: scrollable.scrollWidth - scrollable.clientWidth,
      };
    });

    expect(after.cellWidth).toBeLessThan(after.nestedWidth - 80);
    expect(after.overflow).toBeGreaterThan(40);
    if (before.cellWidth > after.nestedWidth - 80) {
      expect(after.cellWidth).toBeLessThan(before.cellWidth - 40);
    }
  });

  test('dragging a host column wider than its nested table does not stop at the nested table width', async ({
    editor,
    page,
  }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();

    const headerCell = page.locator('.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr:first-child > th').first();
    const before = await headerCell.evaluate((element) => element.getBoundingClientRect().width);

    const edge = await headerCell.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + Math.min(16, rect.height / 2) };
    });

    await page.mouse.move(edge.x, edge.y);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(edge.x + 280, edge.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(160);

    const afterWidth = await headerCell.evaluate((element) => element.getBoundingClientRect().width);
    expect(afterWidth).toBeGreaterThan(before + 80);
  });
});

const deletionViewportMarkdown = [
  ...Array.from({ length: 55 }, (_, index) => `before-${index + 1}: ${'x'.repeat(72)}`),
  '',
  '| First | Second |',
  '| --- | --- |',
  `| Keep position | ${'deletable-cell-content '.repeat(8)} |`,
  '| Next row | Other content |',
  '',
  ...Array.from({ length: 55 }, (_, index) => `after-${index + 1}: ${'y'.repeat(72)}`),
].join('\n');

test.describe('Table cell deletion viewport', () => {
  test('deleting in a centered table cell keeps that cell centered', async ({ editor, page }) => {
    await editor.load(deletionViewportMarkdown);
    await editor.waitForReady();

    const scrollArea = page.locator('#editor-scroll-area');
    const cellText = page.locator('.ProseMirror td').filter({ hasText: 'deletable-cell-content' }).first();
    await expect(cellText).toBeVisible();

    await page.evaluate(() => {
      const area = document.getElementById('editor-scroll-area')!;
      const cell = [...document.querySelectorAll('.ProseMirror td')]
        .find((element) => element.textContent?.includes('deletable-cell-content'))! as HTMLElement;
      const areaRect = area.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      area.scrollTop += cellRect.top - areaRect.top - area.clientHeight / 2 + cellRect.height / 2;
    });
    await page.waitForTimeout(80);

    const target = await cellText.boundingBox();
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x + target!.width / 2, target!.y + target!.height / 2);

    const before = await page.evaluate(() => {
      const area = document.getElementById('editor-scroll-area')!;
      const cell = [...document.querySelectorAll('.ProseMirror td')]
        .find((element) => element.textContent?.includes('deletable-cell-content'))! as HTMLElement;
      const rect = cell.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      return { cellTop: rect.top - areaRect.top, scrollTop: area.scrollTop };
    });

    await page.keyboard.press('Backspace');
    await page.waitForTimeout(180);

    const after = await page.evaluate(() => {
      const area = document.getElementById('editor-scroll-area')!;
      const cell = [...document.querySelectorAll('.ProseMirror td')]
        .find((element) => element.textContent?.includes('deletable-cell-content'))! as HTMLElement;
      const rect = cell.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      return { cellTop: rect.top - areaRect.top, scrollTop: area.scrollTop };
    });

    // The content shrinks by one character, but the edited cell remains in the
    // same viewport position instead of jumping to another table cell.
    expect(Math.abs(after.cellTop - before.cellTop)).toBeLessThan(3);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(3);
    await expect(scrollArea).toBeVisible();
  });
});

test.describe('Table row markers follow horizontal scroll', () => {
  const constrainWideTables = async (page: import('@playwright/test').Page) => {
    await page.addStyleTag({
      content: `
        .ProseMirror > .table-wrapper,
        .ProseMirror > .table-wrapper > .table-scrollable,
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable {
          max-width: 420px !important;
        }
        .ProseMirror table.table-manual-width {
          width: 820px !important;
          min-width: 820px !important;
        }
      `,
    });
  };

  const measureRowGripScroll = async (page: import('@playwright/test').Page, scrollableSelector: string) =>
    page.locator(scrollableSelector).first().evaluate((scrollable: HTMLElement) => {
      const table = scrollable.querySelector(':scope > table') as HTMLTableElement;
      const grip = scrollable.querySelector('.table-grip-row') as HTMLElement;
      const beforeGrip = grip.getBoundingClientRect().left;
      const beforeTable = table.getBoundingClientRect().left;
      const overflow = scrollable.scrollWidth - scrollable.clientWidth;
      scrollable.scrollLeft = Math.min(120, Math.max(0, overflow));
      const afterGrip = grip.getBoundingClientRect().left;
      const afterTable = table.getBoundingClientRect().left;
      return {
        overflow,
        scrollLeft: scrollable.scrollLeft,
        beforeGap: beforeTable - beforeGrip,
        afterGap: afterTable - afterGrip,
        gripDelta: afterGrip - beforeGrip,
        tableDelta: afterTable - beforeTable,
      };
    });

  test('nested row grips travel with the table left edge', async ({ editor, page }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await constrainWideTables(page);

    const nested = await measureRowGripScroll(page, '.ProseMirror td .table-wrapper > .table-scrollable');
    expect(nested.overflow).toBeGreaterThan(40);
    expect(nested.scrollLeft).toBeGreaterThan(40);
    expect(Math.abs(nested.gripDelta - nested.tableDelta)).toBeLessThan(2);
    expect(nested.gripDelta).toBeLessThan(-40);
    expect(Math.abs(nested.afterGap - nested.beforeGap)).toBeLessThan(2);
  });

  test('outer row grips travel with the table left edge', async ({ editor, page }) => {
    await editor.load(`<table>
<tr>
<th data-colwidth="280">列A</th>
<th data-colwidth="280">列B</th>
<th data-colwidth="280">列C</th>
</tr>
<tr>
<td data-colwidth="280">${WIDE}</td>
<td data-colwidth="280">${WIDE}</td>
<td data-colwidth="280">${WIDE}</td>
</tr>
</table>`);
    await editor.waitForReady();
    await constrainWideTables(page);

    const outer = await measureRowGripScroll(page, '.ProseMirror > .table-wrapper > .table-scrollable');
    expect(outer.overflow).toBeGreaterThan(40);
    expect(outer.scrollLeft).toBeGreaterThan(40);
    expect(Math.abs(outer.gripDelta - outer.tableDelta)).toBeLessThan(2);
    expect(outer.gripDelta).toBeLessThan(-40);
    expect(Math.abs(outer.afterGap - outer.beforeGap)).toBeLessThan(2);
  });
});

test.describe('Table control geometry and reflow performance', () => {
  test('row controls stay inside the real table and resize reflow does not rebuild them', async ({ editor, page }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();

    const nestedWrapper = page.locator('.ProseMirror td .table-wrapper').first();
    await expect(nestedWrapper).toBeVisible();
    const before = await nestedWrapper.evaluate((wrapper) => {
      const table = wrapper.querySelector(':scope > .table-scrollable > table') as HTMLTableElement;
      const controls = wrapper.querySelector(':scope > .table-scrollable > .table-controls') as HTMLElement;
      const tableRect = table.getBoundingClientRect();
      const grips = Array.from(controls.querySelectorAll('.table-grip-row')) as HTMLElement[];
      const addRows = Array.from(controls.querySelectorAll('.table-add-row')) as HTMLElement[];
      return {
        rows: Array.from(table.rows).filter((row) => row.closest('table') === table).length,
        grips: grips.length,
        addRows: addRows.length,
        allWithin: grips.every((grip) => {
          const rect = grip.getBoundingClientRect();
          return rect.top >= tableRect.top - 1 && rect.bottom <= tableRect.bottom + 1;
        }),
        overflow: getComputedStyle(controls).overflow,
      };
    });
    expect(before.grips).toBe(before.rows);
    expect(before.addRows).toBe(before.rows + 1);
    expect(before.allWithin).toBe(true);
    // The corner table grip is positioned just above this band, so clipping
    // must remain disabled even after ResizeObserver geometry refreshes.
    expect(before.overflow).toBe('visible');

    await nestedWrapper.evaluate((wrapper) => {
      const controls = wrapper.querySelector(':scope > .table-scrollable > .table-controls')!;
      const columns = wrapper.querySelector(':scope > .table-scrollable > .table-column-controls')!;
      const state = { rebuilds: 0 };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (
            record.type === 'childList' &&
            (record.target === controls || record.target === columns)
          ) {
            state.rebuilds += 1;
          }
        }
      });
      observer.observe(controls, { childList: true });
      observer.observe(columns, { childList: true });
      (window as any).__tableControlReflowObserver = observer;
      (window as any).__tableControlReflowState = state;
    });

    // A viewport resize delivers ResizeObserver updates to every table. It must
    // refresh existing geometry rather than deleting/recreating all row markers.
    await page.setViewportSize({ width: 1160, height: 800 });
    await page.waitForTimeout(180);
    const after = await page.evaluate(() => {
      const observer = (window as any).__tableControlReflowObserver as MutationObserver;
      observer.disconnect();
      return (window as any).__tableControlReflowState as { rebuilds: number };
    });
    expect(after.rebuilds).toBe(0);
  });
});

test.describe('Table grip toolbar with selection-only updates', () => {
  test('row and column grips open their toolbars without rebuilding controls', async ({ editor, page }) => {
    await editor.load(outerTableMarkdown);
    await editor.waitForReady();

    const wrapper = page.locator('.ProseMirror > .table-wrapper').first();
    const rowGrip = wrapper.locator('.table-grip-row[data-index="1"]');
    await expect(rowGrip).toBeVisible();
    await rowGrip.click({ position: { x: 5, y: 8 } });
    await expect(page.locator('.table-grip-toolbar.visible')).toBeVisible();
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Delete row"]')).toBeVisible();

    await page.mouse.click(1100, 740);
    const columnGrip = wrapper.locator('.table-grip-column[data-index="1"]');
    await expect(columnGrip).toBeVisible();
    await columnGrip.click({ position: { x: 20, y: 2 } });
    await expect(page.locator('.table-grip-toolbar.visible')).toBeVisible();
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Narrow column"]')).toBeVisible();
  });

  test('nested-table column grip opens toolbar without resetting horizontal scroll', async ({ editor, page }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({
      content: `
        .ProseMirror td .table-wrapper,
        .ProseMirror td .table-scrollable { max-width: 420px !important; }
        .ProseMirror table.table-manual-width { width: 820px !important; min-width: 820px !important; }
      `,
    });

    const nested = page.locator('.ProseMirror td .table-wrapper .table-scrollable').first();
    const targetScroll = await nested.evaluate((element: HTMLElement) => {
      element.scrollLeft = Math.min(80, Math.max(0, element.scrollWidth - element.clientWidth));
      return element.scrollLeft;
    });
    expect(targetScroll).toBeGreaterThan(40);

    // Use the actual pointer path instead of Locator.click(): Playwright would
    // scroll a partially obscured grip into view first, which is precisely the
    // nested-scroll regression this test is meant to guard against.
    const wrapper = page.locator('.ProseMirror td .table-wrapper').first();
    const columnGrip = wrapper.locator('.table-grip-column[data-index="0"]');
    // Dispatch the same bubbling mousedown used by a real grip click without
    // Playwright's automatic scroll-into-view, which would mutate the very
    // scroll position being asserted below.
    await columnGrip.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: rect.left + Math.min(12, rect.width / 2),
        clientY: rect.top + 2,
      }));
    });
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Delete column"]')).toBeVisible();
    expect(await nested.evaluate((element: HTMLElement) => element.scrollLeft)).toBeGreaterThan(targetScroll - 4);
  });
});


test.describe('Table corner grip visibility', () => {
  test('the top-left table dot remains clickable after a layout refresh', async ({ editor, page }) => {
    await editor.load(outerTableMarkdown);
    await editor.waitForReady();

    const wrapper = page.locator('.ProseMirror > .table-wrapper').first();
    // Exercise the ResizeObserver/reflow path that previously changed the
    // controls container to overflow:hidden and clipped this grip.
    await page.setViewportSize({ width: 1160, height: 800 });
    await page.waitForTimeout(180);

    const tableGrip = wrapper.locator('.table-controls > .table-grip');
    await expect(tableGrip).toBeVisible();
    const rootEvidence = await tableGrip.evaluate((grip) => {
      const table = grip.closest('.table-wrapper')?.querySelector(':scope > .table-scrollable > table') as HTMLTableElement;
      const gripRect = grip.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        gripRight: gripRect.right,
        gripBottom: gripRect.bottom,
        tableLeft: tableRect.left,
        tableTop: tableRect.top,
      };
    });
    expect(rootEvidence.gripRight).toBeLessThan(rootEvidence.tableLeft - 6);
    expect(rootEvidence.gripBottom).toBeLessThan(rootEvidence.tableTop - 4);
    await tableGrip.click({ position: { x: 7, y: 7 } });
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Delete table"]')).toBeVisible();
  });

  test('nested top-left dot stays completely inside an explicit-width outer cell', async ({ editor, page }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();

    // This matches the production path: once the outer table has an explicit
    // column width, its cells clip overflow to keep long content from expanding
    // that column. The inner table's corner control must stay inside that clip.
    await page.evaluate(() => {
      const outer = document.querySelector('.ProseMirror > .table-wrapper table') as HTMLTableElement;
      outer.classList.add('table-manual-width');
    });
    await page.waitForTimeout(80);

    const nestedWrapper = page.locator('.ProseMirror td .table-wrapper').first();
    const tableGrip = nestedWrapper.locator(':scope > .table-scrollable > .table-controls > .table-grip');
    await expect(tableGrip).toBeVisible();

    const evidence = await tableGrip.evaluate((grip) => {
      const cell = grip.closest('td, th') as HTMLElement | null;
      const table = grip.closest('.table-wrapper')?.querySelector(':scope > .table-scrollable > table') as HTMLTableElement | null;
      if (!cell || !table) throw new Error('Expected nested table grip with its table-cell and table ancestors');
      const gripRect = grip.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        gripLeft: gripRect.left,
        gripRight: gripRect.right,
        gripCenter: gripRect.left + gripRect.width / 2,
        tableLeft: tableRect.left,
        tableTop: tableRect.top,
        tableGripWidth: gripRect.width,
        gripBottom: gripRect.bottom,
        cellLeft: cellRect.left,
        cellRight: cellRect.right,
        cellOverflow: getComputedStyle(cell).overflow,
      };
    });

    expect(evidence.cellOverflow).toBe('hidden');
    expect(evidence.gripLeft).toBeGreaterThanOrEqual(evidence.cellLeft - 0.5);
    expect(evidence.gripRight).toBeLessThanOrEqual(evidence.cellRight + 0.5);
    expect(evidence.gripRight).toBeLessThan(evidence.tableLeft - 6);
    expect(evidence.gripBottom).toBeLessThan(evidence.tableTop - 4);
    await tableGrip.click({ position: { x: 7, y: 7 } });
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Delete table"]')).toBeVisible();
  });
});

const verticalAlignMarkdown = `<table>
<tr><th>短内容</th><th>长内容</th></tr>
<tr><td>需要居中</td><td>第一行<br>第二行<br>第三行<br>第四行<br>第五行</td></tr>
</table>`;

const verticalAlignOverflowMarkdown = `<table>
<tr><th>短内容</th><th>长内容</th></tr>
<tr><td>短内容</td><td>第一行<br>第二行<br>第三行<br>第四行<br>第五行<br>第六行<br>第七行<br>第八行<br>第九行<br>第十行</td></tr>
</table>`;

test.describe('Table row alignment', () => {
  test('row toolbar can center every cell in the selected row', async ({ editor, page }) => {
    await editor.load(`<table>
<tr><th>列A</th><th>列B</th></tr>
<tr><td>左</td><td>右</td></tr>
</table>`);
    await editor.waitForReady();

    const wrapper = page.locator('.ProseMirror > .table-wrapper').first();
    const rowGrip = wrapper.locator('.table-grip-row[data-index="1"]');
    await expect(rowGrip).toBeVisible();
    await rowGrip.click({ position: { x: 5, y: 8 } });
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Align center"]')).toBeVisible();
    await page.locator('.table-grip-toolbar.visible button[aria-label="Align center"]').click();
    await page.waitForTimeout(80);

    const alignments = await wrapper.locator('table tr:nth-child(2) td').evaluateAll((cells) =>
      cells.map((cell) => getComputedStyle(cell).textAlign)
    );
    expect(alignments).toEqual(['center', 'center']);
  });

  test('row toolbar can vertically center every cell in the selected row', async ({ editor, page }) => {
    await editor.load(verticalAlignMarkdown);
    await editor.waitForReady();

    const wrapper = page.locator('.ProseMirror > .table-wrapper').first();
    const cell = wrapper.locator('table tr:nth-child(2) td').first();
    const cellBox = await cell.boundingBox();
    expect(cellBox).not.toBeNull();
    if (!cellBox) throw new Error('Expected the target table cell to have a bounding box');

    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height - 1);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height + 100, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);

    const rowGrip = wrapper.locator('.table-grip-row[data-index="1"]');
    await rowGrip.click({ position: { x: 5, y: 8 } });
    await page.locator('.table-grip-toolbar.visible button[aria-label="Align middle"]').click();
    await page.waitForTimeout(100);

    const result = await cell.evaluate((tableCell) => {
      const content = tableCell.querySelector(':scope > .easyview-table-cell-content') as HTMLElement;
      const child = content.firstElementChild as HTMLElement;
      const contentRect = content.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      return {
        mode: content.dataset.easyviewVerticalAlignment,
        childOffset: childRect.top - contentRect.top,
        freeSpace: contentRect.height - childRect.height,
      };
    });
    expect(result.mode).toBe('middle');
    expect(result.freeSpace).toBeGreaterThan(80);
    expect(result.childOffset).toBeGreaterThan(result.freeSpace * 0.35);
    expect(result.childOffset).toBeLessThan(result.freeSpace * 0.65);
  });
});

test.describe('Table column vertical alignment', () => {
  test('Align middle centers a column cell after a real row-height drag', async ({ editor, page }) => {
    await editor.load(verticalAlignMarkdown);
    await editor.waitForReady();

    const wrapper = page.locator('.ProseMirror > .table-wrapper').first();
    const cell = wrapper.locator('table tr:nth-child(2) td').first();
    const cellBox = await cell.boundingBox();
    expect(cellBox).not.toBeNull();
    if (!cellBox) throw new Error('Expected the target table cell to have a bounding box');

    // Exercise the exact pointer path users take. This creates the fixed
    // content viewport that made native td vertical-align a no-op.
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height - 1);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height + 100, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);

    const columnGrip = wrapper.locator('.table-grip-column[data-index="0"]');
    await expect(columnGrip).toBeVisible();
    await columnGrip.click({ position: { x: 16, y: 2 } });
    await expect(page.locator('.table-grip-toolbar.visible button[aria-label="Align middle"]')).toBeVisible();
    await page.locator('.table-grip-toolbar.visible button[aria-label="Align middle"]').click();
    await page.waitForTimeout(100);

    const result = await cell.evaluate((tableCell) => {
      const content = tableCell.querySelector(':scope > .easyview-table-cell-content') as HTMLElement;
      const child = content.firstElementChild as HTMLElement;
      const contentRect = content.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      return {
        mode: content.dataset.easyviewVerticalAlignment,
        childOffset: childRect.top - contentRect.top,
        freeSpace: contentRect.height - childRect.height,
      };
    });
    expect(result.mode).toBe('middle');
    expect(result.freeSpace).toBeGreaterThan(80);
    expect(result.childOffset).toBeGreaterThan(result.freeSpace * 0.35);
    expect(result.childOffset).toBeLessThan(result.freeSpace * 0.65);
  });

  test('middle alignment keeps overflowing fixed-height cell content scrollable from its first line', async ({ editor, page }) => {
    await editor.load(verticalAlignOverflowMarkdown);
    await editor.waitForReady();

    const wrapper = page.locator('.ProseMirror > .table-wrapper').first();
    const longCell = wrapper.locator('table tr:nth-child(2) td').nth(1);
    const cellBox = await longCell.boundingBox();
    expect(cellBox).not.toBeNull();
    if (!cellBox) throw new Error('Expected the overflowing cell to have a bounding box');
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height - 1);
    await page.waitForTimeout(80);
    await page.mouse.down();
    // Drag upward to make the existing tall row shorter than the long content.
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + 55, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);

    const columnGrip = wrapper.locator('.table-grip-column[data-index="1"]');
    await columnGrip.click({ position: { x: 16, y: 2 } });
    await page.locator('.table-grip-toolbar.visible button[aria-label="Align middle"]').click();
    await page.waitForTimeout(100);

    const result = await longCell.evaluate((tableCell) => {
      const content = tableCell.querySelector(':scope > .easyview-table-cell-content') as HTMLElement;
      const firstChild = content.firstElementChild as HTMLElement;
      const contentRect = content.getBoundingClientRect();
      const childRect = firstChild.getBoundingClientRect();
      return {
        mode: content.dataset.easyviewVerticalAlignment || null,
        overflowY: getComputedStyle(content).overflowY,
        scrollHeight: content.scrollHeight,
        clientHeight: content.clientHeight,
        firstLineOffset: childRect.top - contentRect.top,
      };
    });
    expect(result.scrollHeight).toBeGreaterThan(result.clientHeight);
    expect(result.mode).toBeNull();
    expect(result.overflowY).toBe('auto');
    expect(result.firstLineOffset).toBeLessThan(2);
  });
});

const stickyFirstRowMarkdown = `<table>
<tr><th>固定列一</th><th>固定列二</th></tr>
${Array.from({ length: 36 }, (_, index) => `<tr><td>第 ${index + 1} 行</td><td>用于验证冻结第一行在编辑器纵向滚动时始终可见</td></tr>`).join('\n')}
</table>`;

test.describe('Table sticky first row', () => {
  test('first-row toolbar toggles, pins, and serializes the sticky state', async ({ editor, page }) => {
    await editor.load(stickyFirstRowMarkdown);
    await editor.waitForReady();
    await page.addStyleTag({ content: '#editor-scroll-area { height: 300px !important; overflow-y: auto !important; }' });
    await page.waitForTimeout(120);
    await page.mouse.click(8, 8);

    const firstRowGrip = page.locator('.ProseMirror > .table-wrapper .table-grip-row[data-index="0"]');
    await expect(firstRowGrip).toBeVisible();
    await firstRowGrip.click({ position: { x: 5, y: 8 } });
    await expect(page.locator('.table-grip-toolbar.visible')).toBeVisible();

    const stickyToggle = page.locator('button[aria-label="Keep first row visible"]');
    await expect(stickyToggle).toBeVisible();
    await expect(stickyToggle).toHaveAttribute('aria-pressed', 'false');
    await stickyToggle.click();
    await expect(stickyToggle).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.click(8, 8);

    const firstRow = page.locator('.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr').first();
    await expect(firstRow).toHaveAttribute('data-easyview-sticky', 'true');

    const geometry = await page.evaluate(async () => {
      const scrollArea = document.getElementById('editor-scroll-area')!;
      const table = document.querySelector('.ProseMirror > .table-wrapper > .table-scrollable > table')!;
      const maxScroll = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
      scrollArea.scrollTop = Math.min(220, maxScroll);
      scrollArea.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const stickyOverlay = document.querySelector('.easyview-sticky-table-header') as HTMLElement;
      const overlayTable = stickyOverlay.querySelector('table') as HTMLTableElement;
      const sourceCells = Array.from(table.querySelector('tbody > tr')!.children) as HTMLTableCellElement[];
      const overlayCells = Array.from(overlayTable.querySelector('tbody > tr')!.children) as HTMLTableCellElement[];
      const laterCell = table.querySelector('tbody > tr:nth-child(8) > td')!;
      return {
        scrollTop: scrollArea.scrollTop,
        maxScroll,
        scrollOverflow: scrollArea.scrollHeight - scrollArea.clientHeight,
        scrollTopEdge: scrollArea.getBoundingClientRect().top,
        overlayDisplay: stickyOverlay.style.display,
        overlayBackground: getComputedStyle(stickyOverlay).backgroundColor,
        overlayBackgroundAlpha: (() => {
          const color = getComputedStyle(stickyOverlay).backgroundColor;
          const match = color.match(/rgba?\([^)]+,\s*([\d.]+)\s*\)/);
          return match ? Number(match[1]) : 1;
        })(),
        editorBackground: getComputedStyle(document.getElementById('editor')!).backgroundColor,
        overlayTop: stickyOverlay.getBoundingClientRect().top,
        overlayWidth: stickyOverlay.getBoundingClientRect().width,
        tableWidth: table.getBoundingClientRect().width,
        laterTop: laterCell.getBoundingClientRect().top,
        sourceCellEdges: sourceCells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          const style = getComputedStyle(cell);
          return {
            left: rect.left,
            right: rect.right,
            borderLeft: style.borderLeftWidth,
            backgroundColor: style.backgroundColor,
          };
        }),
        overlayCellEdges: overlayCells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          const style = getComputedStyle(cell);
          return {
            left: rect.left,
            right: rect.right,
            borderLeft: style.borderLeftWidth,
            backgroundColor: style.backgroundColor,
            backgroundAlpha: (() => {
              const match = style.backgroundColor.match(/rgba?\([^)]+,\s*([\d.]+)\s*\)/);
              return match ? Number(match[1]) : 1;
            })(),
            textAlign: style.textAlign,
            verticalAlign: style.verticalAlign,
          };
        }),
      };
    });
    expect(geometry.scrollOverflow).toBeGreaterThan(100);
    expect(geometry.scrollTop).toBeGreaterThan(40);
    expect(geometry.overlayDisplay).toBe('block');
    expect(Math.abs(geometry.overlayTop - geometry.scrollTopEdge)).toBeLessThan(3);
    expect(Math.abs(geometry.overlayWidth - geometry.tableWidth)).toBeLessThan(1);
    expect(geometry.overlayCellEdges).toHaveLength(geometry.sourceCellEdges.length);
    geometry.overlayCellEdges.forEach((overlayCell, index) => {
      const sourceCell = geometry.sourceCellEdges[index];
      expect(Math.abs(overlayCell.left - sourceCell.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(overlayCell.right - sourceCell.right)).toBeLessThanOrEqual(1);
      expect(overlayCell.borderLeft).not.toBe('0px');
      expect(overlayCell.backgroundAlpha).toBeGreaterThanOrEqual(0.99);
      expect(overlayCell.backgroundColor).toBe(sourceCell.backgroundColor);
      expect(overlayCell.textAlign).toBe('center');
      expect(overlayCell.verticalAlign).toBe('middle');
    });
    expect(geometry.laterTop).toBeGreaterThan(geometry.scrollTopEdge + 20);

    // Persistence is represented in the table-row schema and the DOM attribute.
    // Markdown serialization uses the HTML-table branch whenever this flag is present.
  });

  test('sticky state survives serialization and a fresh document load', async ({ editor, page }) => {
    await editor.load(stickyFirstRowMarkdown);
    await editor.waitForReady();
    const firstRowGrip = page.locator('.ProseMirror > .table-wrapper .table-grip-row[data-index="0"]');
    await firstRowGrip.click({ position: { x: 5, y: 8 } });
    await page.locator('button[aria-label="Keep first row visible"]').click();
    await page.waitForTimeout(180);

    const markdown = await editor.getMarkdown();
    expect(markdown).toContain('data-easyview-sticky="true"');

    await editor.load(markdown);
    await editor.waitForReady();
    await expect(page.locator('.ProseMirror > .table-wrapper > .table-scrollable > table > tbody > tr').first())
      .toHaveAttribute('data-easyview-sticky', 'true');
  });
});

test.describe('Nested table gutter alignment', () => {
  test('centres a nested manual-width table inside its outer cell', async ({ editor, page }) => {
    await editor.load(nestedQingdanMarkdown);
    await editor.waitForReady();

    const result = await page.locator('.ProseMirror td .table-wrapper').first().evaluate((wrapper) => {
      const cell = wrapper.closest('td, th') as HTMLElement;
      const table = wrapper.querySelector(':scope > .table-scrollable > table') as HTMLTableElement;
      const cellRect = cell.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {
        leftGap: tableRect.left - cellRect.left,
        rightGap: cellRect.right - tableRect.right,
        overflow: (wrapper.querySelector(':scope > .table-scrollable') as HTMLElement).scrollWidth -
          (wrapper.querySelector(':scope > .table-scrollable') as HTMLElement).clientWidth,
      };
    });

    // Nested wrappers shrink to the table's actual width. They must be centred
    // in an outer cell rather than leaving all spare width on the right.
    expect(Math.abs(result.leftGap - result.rightGap)).toBeLessThanOrEqual(1);
    expect(result.overflow).toBeGreaterThanOrEqual(0);
  });
});
