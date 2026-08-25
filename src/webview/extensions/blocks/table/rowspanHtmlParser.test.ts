/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import { docToMarkdown } from '../../../editor/lib/MarkdownSerializer';

describe('HTML table rowspan parsing', () => {
  it('keeps rowspan and logical cell placement', () => {
    const doc = parseMarkdown(`<table>
<tr><td rowspan="2">一级</td><td rowspan="2">一级描述</td><td>三级A</td></tr>
<tr><td>三级B</td></tr>
</table>`, createParser())!;
    const table = doc.firstChild!;
    expect(table.child(0).child(0).attrs.rowspan).toBe(2);
    expect(table.child(0).child(1).attrs.rowspan).toBe(2);
    expect(table.child(1).child(0).textContent).toBe('三级B');
  });
  it('round-trips rowspan and legacy auto-merge flags without losing table structure', () => {
    const source = `<table>
<tr><td rowspan="3" data-easyview-auto-merged="true">一级</td><td>三级A</td></tr>
<tr><td>三级B</td></tr>
<tr><td>三级C</td></tr>
</table>`;
    const first = parseMarkdown(source, createParser())!;
    const serialized = docToMarkdown(first);
    expect(serialized).toContain('rowspan="3"');
    expect(serialized).toContain('data-easyview-auto-merged="true"');

    const second = parseMarkdown(serialized, createParser())!;
    const table = second.firstChild!;
    expect(table.child(0).child(0).attrs.rowspan).toBe(3);
    expect(table.child(0).child(0).attrs.autoMerged).toBe(true);
    expect(table.child(2).child(0).textContent).toBe('三级C');
  });

});
