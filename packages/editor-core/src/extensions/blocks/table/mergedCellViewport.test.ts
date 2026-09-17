/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { schema } from '../../../editor/EditorSchema';
import { TableCellView } from './TableCellView';

function cell(rowspan: number, colspan = 1) {
  const paragraph = schema.nodes.paragraph.create(null, schema.text('合并内容'));
  return schema.nodes.table_cell.create({ rowspan, colspan }, paragraph);
}

describe('merged cell viewport', () => {
  it('marks merged cells and forces middle/left visual alignment', () => {
    const view = new TableCellView(cell(3));
    expect(view.dom.getAttribute('data-easyview-merged-cell')).toBe('true');
    expect(view.dom.rowSpan).toBe(3);
    expect(view.dom.style.verticalAlign).toBe('middle');
    expect(view.dom.style.textAlign).toBe('left');

    expect(view.update(cell(1))).toBe(true);
    expect(view.dom.hasAttribute('data-easyview-merged-cell')).toBe(false);
    expect(view.dom.rowSpan).toBe(1);
  });
});
