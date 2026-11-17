/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';
import { createSourceEditor } from './SourceEditor';

describe('document source headings', () => {
  let editor: ReturnType<typeof createSourceEditor> | undefined;
  afterEach(() => { editor?.destroy(); editor = undefined; document.body.replaceChildren(); });

  const open = (visualMode?: 'documentSource') => {
    const parent = document.createElement('div'); document.body.append(parent);
    editor = createSourceEditor({ parent, onChange: () => {}, visualMode });
    editor.setContent('# 需求说明\n\n正文\n\n  ##   分类分级\n\n```bash\n# 安装依赖\n```\n');
    return parent;
  };

  it('marks only heading markers and their spaces, not # comments inside code blocks', () => {
    const parent = open('documentSource');
    expect([...parent.querySelectorAll('.cm-heading-marker')].map(node => node.textContent)).toEqual(['# ', '##   ']);
  });

  it('leaves the default source editor unchanged', () => {
    const parent = open();
    expect(parent.querySelectorAll('.cm-heading-marker')).toHaveLength(0);
  });
});
