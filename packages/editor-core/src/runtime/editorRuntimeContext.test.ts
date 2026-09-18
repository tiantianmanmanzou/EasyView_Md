import { describe, expect, it } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import type { EditorHostTransport } from '@easyview/contracts';

import { createEditorRuntimeContext } from './editorRuntimeContext';

describe('EditorRuntimeContext', () => {
  it('returns the EditorView supplied by the owning table runtime', () => {
    const view = {} as EditorView;
    const host = {} as EditorHostTransport;
    const runtime = createEditorRuntimeContext(view, host);

    expect(runtime.getEditorView()).toBe(view);
    expect(runtime.host).toBe(host);
  });
});
