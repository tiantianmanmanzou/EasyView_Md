/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../../editor/EditorSchema';
import { TableOfContents } from './TableOfContents';

function heading(level: number, text: string) {
  return schema.node('heading', { level }, schema.text(text));
}

function createHeadingToc(): { toc: TableOfContents; view: EditorView } {
  document.body.innerHTML = `
    <div id="editor-body">
      <div id="editor-scroll-area">
        <div id="editor" class="ProseMirror"></div>
      </div>
    </div>
  `;
  const doc = schema.node('doc', null, [
    heading(1, '事件处置工单'),
    heading(2, '基本信息'),
    heading(2, '关联事件添加抽屉'),
    heading(3, '完整布局图'),
    heading(3, '交互矩阵'),
    heading(3, '录入规则'),
    heading(2, '流转记录添加弹窗'),
    heading(3, '完整布局图'),
    heading(4, '字段说明'),
  ]);
  const mount = document.getElementById('editor')!;
  const view = new EditorView(mount, { state: EditorState.create({ schema, doc }) });
  const toc = new TableOfContents(view);
  toc.open();
  return { toc, view };
}

function createTableToc(): { toc: TableOfContents; view: EditorView } {
  document.body.innerHTML = `
    <div id="editor-body">
      <div id="editor-scroll-area">
        <div id="editor" class="ProseMirror"></div>
      </div>
    </div>
  `;
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('table outline')),
  ]);
  const mount = document.getElementById('editor')!;
  const view = new EditorView(mount, { state: EditorState.create({ schema, doc }) });
  view.dom.insertAdjacentHTML('beforeend', `
    <table>
      <tr><th>一级</th><th>二级</th><th>三级</th><th>四级</th></tr>
      <tr><td>事件处置工单</td><td>关联事件添加抽屉</td><td>完整布局图</td><td>字段说明</td></tr>
      <tr><td>事件处置工单</td><td>关联事件添加抽屉</td><td>交互矩阵</td><td></td></tr>
      <tr><td>事件处置工单</td><td>流转记录添加弹窗</td><td>录入规则</td><td></td></tr>
    </table>
  `);
  const toc = new TableOfContents(view);
  toc.open();
  document.querySelectorAll<HTMLButtonElement>('.toc-table-mode-option')[1]?.click();
  return { toc, view };
}

function visibleHeadingLabels(): string[] {
  return [...document.querySelectorAll('.toc-item-text')].map((el) => el.textContent ?? '');
}

function visibleTableLabels(): string[] {
  return [...document.querySelectorAll('.toc-table-node-label')].map((el) => el.textContent ?? '');
}

function clickLevelFilter(label: string): void {
  const btn = [...document.querySelectorAll<HTMLButtonElement>('.toc-level-btn')]
    .find((el) => el.textContent === label);
  btn?.click();
}

function clickHeadingToggle(label: string): void {
  const item = [...document.querySelectorAll('.toc-item')].find(
    (el) => el.querySelector('.toc-item-text')?.textContent === label,
  );
  (item?.querySelector('.toc-item-toggle') as HTMLButtonElement | null)?.click();
}

function clickTableToggle(label: string): void {
  const item = [...document.querySelectorAll('.toc-table-item')].find(
    (el) => el.querySelector('.toc-table-node-label')?.textContent === label,
  );
  (item?.querySelector('.toc-table-node-toggle') as HTMLButtonElement | null)?.click();
}

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe('TableOfContents one-level expand', () => {
  it('H1 filter: expanding a heading reveals only the next level', () => {
    const { toc, view } = createHeadingToc();
    clickLevelFilter('H1');
    expect(visibleHeadingLabels()).toEqual(['事件处置工单']);

    clickHeadingToggle('事件处置工单');
    expect(visibleHeadingLabels()).toEqual([
      '事件处置工单',
      '基本信息',
      '关联事件添加抽屉',
      '流转记录添加弹窗',
    ]);

    toc.destroy();
    view.destroy();
  });

  it('H1 filter: re-expanding a parent does not restore grandchild expand state', () => {
    const { toc, view } = createHeadingToc();
    clickLevelFilter('H1');
    clickHeadingToggle('事件处置工单');
    clickHeadingToggle('关联事件添加抽屉');
    expect(visibleHeadingLabels()).toContain('完整布局图');
    expect(visibleHeadingLabels()).toContain('交互矩阵');

    clickHeadingToggle('事件处置工单');
    clickHeadingToggle('事件处置工单');
    expect(visibleHeadingLabels()).toEqual([
      '事件处置工单',
      '基本信息',
      '关联事件添加抽屉',
      '流转记录添加弹窗',
    ]);

    toc.destroy();
    view.destroy();
  });

  it('show-all: expanding a collapsed heading reveals only the next level', () => {
    const { toc, view } = createHeadingToc();
    expect(visibleHeadingLabels()).toContain('字段说明');

    clickHeadingToggle('事件处置工单');
    clickHeadingToggle('事件处置工单');
    expect(visibleHeadingLabels()).toEqual([
      '事件处置工单',
      '基本信息',
      '关联事件添加抽屉',
      '流转记录添加弹窗',
    ]);

    toc.destroy();
    view.destroy();
  });

  it('table H1 filter: expanding a parent reveals only direct children', () => {
    const { toc, view } = createTableToc();
    clickLevelFilter('H1');
    expect(visibleTableLabels()).toEqual(['事件处置工单']);

    clickTableToggle('事件处置工单');
    expect(visibleTableLabels()).toEqual([
      '事件处置工单',
      '关联事件添加抽屉',
      '流转记录添加弹窗',
    ]);

    toc.destroy();
    view.destroy();
  });

  it('table H1 filter: expanding a child then re-expanding the parent keeps grandchildren collapsed', () => {
    const { toc, view } = createTableToc();
    clickLevelFilter('H1');
    clickTableToggle('事件处置工单');
    clickTableToggle('关联事件添加抽屉');
    expect(visibleTableLabels()).toContain('完整布局图');

    clickTableToggle('事件处置工单');
    clickTableToggle('事件处置工单');
    expect(visibleTableLabels()).toEqual([
      '事件处置工单',
      '关联事件添加抽屉',
      '流转记录添加弹窗',
    ]);

    toc.destroy();
    view.destroy();
  });
});
