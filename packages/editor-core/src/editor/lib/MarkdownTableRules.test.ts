/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';

import { createParser, parseMarkdown } from './MarkdownParser';
import { parseHtmlTableBlock } from './HtmlTableParser';
import { docToMarkdown, compactHtmlTableMarkdown } from './MarkdownSerializer';

describe('HTML table reconstruction', () => {
  it('keeps paragraphs before and after a nested HTML table inside a cell', () => {
    const markdown = `<table>
<tr><th>A</th><th>B</th></tr>
<tr><td>outer</td><td>
<p>【需求说明】</p>
<p>leading paragraph before nested table</p>
<table border="1">
<tr><th>状态大类</th><th>状态小类</th></tr>
<tr><td>库状态</td><td>库</td></tr>
</table>
<p>trailing paragraph after nested table</p>
</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    expect(doc).not.toBeNull();

    const lastCell = doc!.child(0).child(1).child(1);
    expect(lastCell.textContent).toContain('【需求说明】');
    expect(lastCell.textContent).toContain('leading paragraph before nested table');
    expect(lastCell.textContent).toContain('状态大类');
    expect(lastCell.textContent).toContain('trailing paragraph after nested table');

    let nestedTables = 0;
    lastCell.descendants((node) => {
      if (node.type.name === 'table') nestedTables += 1;
      return true;
    });
    expect(nestedTables).toBe(1);
    expect(lastCell.childCount).toBeGreaterThan(2);
  });

  it('keeps outer table rows after a nested HTML table', () => {
    const markdown = `<table>
<tr><td>first</td><td>
<table>
<tr><td>nested header</td></tr>
<tr><td>nested value</td></tr>
</table>
</td></tr>
<tr><td>second</td><td>outer row after nested table</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    expect(doc).not.toBeNull();

    const tables: Array<{ parent: string; rows: number }> = [];
    doc!.descendants((node, _pos, parent) => {
      if (node.type.name === 'table') {
        tables.push({ parent: parent!.type.name, rows: node.childCount });
      }
      return true;
    });

    expect(tables).toEqual([
      { parent: 'doc', rows: 2 },
      { parent: 'table_cell', rows: 2 },
    ]);
  });
});

describe('Pandoc highlight spans', () => {
  it('does not keep span.mark tags in heading text', () => {
    const doc = parseMarkdown('## <span class="mark">数据安全管控</span>\n', createParser());
    expect(doc).not.toBeNull();
    const heading = doc!.child(0);
    expect(heading.type.name).toBe('heading');
    expect(heading.textContent).toBe('数据安全管控');
    let htmlInline = 0;
    heading.descendants((node) => {
      if (node.type.name === 'html_inline') htmlInline += 1;
      return true;
    });
    expect(htmlInline).toBe(0);
  });
});

describe('persistent HTML table row state', () => {
  it('restores a sticky first row from serialized HTML on file reload', () => {
    const markdown = `<table>
<tr data-easyview-sticky="true"><th>名称</th><th>说明</th></tr>
<tr><td>资产</td><td>资源信息</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    expect(doc).not.toBeNull();
    expect(doc!.firstChild!.firstChild!.attrs.sticky).toBe(true);
    expect(doc!.firstChild!.child(1).attrs.sticky).toBe(false);
  });
});

describe('GFM tables inside HTML table cells', () => {
  it('preserves plain-text paragraphs before a GFM table in an HTML td', () => {
    const markdown = `<table>
<tr><td>outer</td><td>
【需求说明】

本期需提供智能分类分级管理能力。

表 E类数据详细内容

| 子类 | 范围 | 对应数据 |
| --- | --- | --- |
| E1 网络规划建设类数据 | E1-1 网络规划类数据 | 网络建设 |
</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    expect(doc).not.toBeNull();

    const lastCell = doc!.child(0).child(0).child(1);
    expect(lastCell.textContent).toContain('【需求说明】');
    expect(lastCell.textContent).toContain('本期需提供智能分类分级管理能力');
    expect(lastCell.textContent).toContain('E1-1 网络规划类数据');
    expect(lastCell.childCount).toBeGreaterThan(1);
  });

  it('preserves a single-line cell prefix split into an html_block by markdown-it', () => {
    const markdown = `<table>
<tr><td>outer</td><td>
【需求说明】

line after blank
</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    const lastCell = doc!.child(0).child(0).child(1);
    expect(lastCell.textContent).toContain('【需求说明】');
    expect(lastCell.textContent).toContain('line after blank');
  });

  it('parses GFM tables that follow leading text within one HTML td blob', () => {
    const markdown = `<table><tr><td>【需求说明】

intro paragraph

| 子类 | 范围 |
| --- | --- |
| E1 | E1-1 |
</td></tr></table>`;

    const doc = parseMarkdown(markdown, createParser());
    const cell = doc!.child(0).child(0).child(0);
    expect(cell.textContent).toContain('【需求说明】');
    expect(cell.textContent).toContain('intro paragraph');
    expect(cell.textContent).toContain('E1-1');

    let nestedTables = 0;
    cell.descendants((node) => {
      if (node.type.name === 'table') nestedTables += 1;
      return true;
    });
    expect(nestedTables).toBe(1);
  });

  it('parses a standard GFM table embedded directly in an outer HTML td', () => {
    const markdown = `<table>
<tr><td>outer</td><td>
<!-- no-header -->
| 二级功能 | 三级功能 | 功能描述 |
| --- | --- | --- |
| 资产管理 | 资源画像 | 展示资源信息 |
| 资产管理 | 连接信息 | 展示连接信息 |
</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    expect(doc).not.toBeNull();

    const tables: Array<{ parent: string; rows: number }> = [];
    doc!.descendants((node, _pos, parent) => {
      if (node.type.name === 'table') tables.push({ parent: parent!.type.name, rows: node.childCount });
      return true;
    });

    expect(tables).toEqual([
      { parent: 'doc', rows: 1 },
      { parent: 'table_cell', rows: 3 },
    ]);

    const cell = doc!.child(0).child(0).child(1);
    let nestedTable: typeof cell | null = null;
    cell.forEach((child) => {
      if (child.type.name === 'table') nestedTable = child;
    });
    expect(nestedTable).not.toBeNull();
    expect(nestedTable!.firstChild!.firstChild!.type.name).toBe('table_cell');
  });

  it('applies no-header marker to nested GFM tables parsed from cell markdown', () => {
    const parser = createParser();
    const nested = parseHtmlTableBlock(`<table><tr><td><!-- no-header -->
| A | B |
| --- | --- |
| 1 | 2 |
</td></tr></table>`, parser);
    expect(nested!.firstChild!.firstChild!.type.name).toBe('table_cell');
  });
});

const realSpecPath =
  '/Users/zhangxy/GAFile/浙江中台/浙江数安中台5期/项目管理/技术规范书-采购包1-数安中台-软件功能要求模块清单.md';

describe.runIf(existsSync(realSpecPath))('real-world spec file', () => {
  it('keeps 【需求说明】 in cells that mix HTML tables and GFM tables', () => {
    const markdown = readFileSync(realSpecPath, 'utf8');
    const doc = parseMarkdown(markdown, createParser());
    expect(doc).not.toBeNull();

    let found = false;
    doc!.descendants((node) => {
      if (
        node.type.name === 'table_cell' &&
        node.textContent.includes('【需求说明】') &&
        node.textContent.includes('智能分类分级')
      ) {
        found = true;
      }
      return true;
    });
    expect(found).toBe(true);
  });
});

describe('compact HTML table serialization', () => {
  it('keeps simple rows on one line and attaches closing tags to cell content', () => {
    const markdown = `<table>
<tr>
<th></th><th align="middle" valign="middle">一级模块</th><th>功能描述</th>
</tr>
<tr>
<td></td><td align="middle" valign="middle">数安治理中心</td><td>
【需求说明】

leading paragraph
</td>
</tr>
<tr><td></td><td>第二行</td><td>short</td></tr>
</table>`;

    const doc = parseMarkdown(markdown, createParser());
    const saved = docToMarkdown(doc!);

    expect(saved).toContain(
      '<tr><th></th><th align="middle" valign="middle">一级模块</th><th>功能描述</th></tr>',
    );
    expect(saved).toContain('leading paragraph</td></tr>');
    expect(saved).toContain('<tr><td></td><td>第二行</td><td>short</td></tr>');
    expect(saved).not.toMatch(/^\s*<\/td>\s*$/m);
    expect(saved).not.toMatch(/^\s*<\/tr>\s*$/m);
    expect(saved).not.toMatch(/^\s*<tr>\s*$/m);

    const roundTrip = parseMarkdown(saved, createParser());
    expect(roundTrip!.textContent).toContain('【需求说明】');
    expect(roundTrip!.textContent).toContain('leading paragraph');
    expect(roundTrip!.textContent).toContain('第二行');
  });

  it('compacts real spec file row boundaries on save', () => {
    const realSpecPath =
      '/Users/zhangxy/GAFile/浙江中台/浙江数安中台5期/项目管理/技术规范书-采购包1-数安中台-软件功能要求模块清单.md';
    if (!existsSync(realSpecPath)) return;

    const markdown = readFileSync(realSpecPath, 'utf8');
    const saved = docToMarkdown(parseMarkdown(markdown, createParser())!);
    const lines = saved.split('\n');
    const standaloneTags = lines.filter((line) => /^<\/?(?:tr|td|th)>\s*$/.test(line));

    expect(standaloneTags).toEqual([]);
    expect(lines.some((line) => /^<tr><td/.test(line))).toBe(true);
  });

  it('compacts legacy standalone table tags line-by-line', () => {
    const legacy = `<table>
<tr>
<td></td><td>简单列</td><td>
段落内容
</td>
</tr>
<tr>
<td></td><td>下一行</td><td>短文本</td>
</tr>
</table>`;

    const compact = compactHtmlTableMarkdown(legacy);
    expect(compact).toContain('段落内容</td></tr>');
    expect(compact).toContain('<tr><td></td><td>下一行</td><td>短文本</td></tr>');
    expect(compact).not.toMatch(/^\s*<\/tr>\s*$/m);
    expect(compact).not.toMatch(/^\s*<tr>\s*$/m);

    const roundTrip = parseMarkdown(compact, createParser());
    expect(roundTrip!.textContent).toContain('段落内容');
    expect(roundTrip!.textContent).toContain('下一行');
  });
});
