import { describe, expect, it } from 'vitest';
import type { HostToEditorMessage } from '@easyview/contracts';
import { EditorSyncAdapter } from './editorSyncAdapter';
import { hashContent } from '@easyview/editor-sync';

describe('EditorSyncAdapter', () => {
  it('sends only applyEdits after a snapshot and acknowledges without replaying content', () => {
    const sent: any[] = [];
    const applied: string[] = [];
    const adapter = new EditorSyncAdapter({
      postMessage: (message) => sent.push(message),
      getSettings: () => ({ fullWidth: true, tocVisible: false, tableWrap: false }),
      onSnapshot: (content) => applied.push(content),
      onExternalContent: (content) => { applied.push(content); return true; },
    });
    const snapshot: HostToEditorMessage = { type: 'documentSnapshot', documentId: 'doc', revision: 4, content: 'abc', contentHash: 'ignored' };
    expect(adapter.handleMessage(snapshot)).toBe(true);
    adapter.applyLocalContent('abXc');
    expect(sent.map((message) => message.type)).toEqual(['snapshotApplied', 'applyEdits']);
    expect(sent[1].edits).toEqual([{ from: 2, to: 2, insert: 'X' }]);
    adapter.handleMessage({ type: 'editsApplied', documentId: 'doc', clientEditId: sent[1].clientEditId, revision: 5, resultHash: sent[1].resultHash });
    expect(applied).toEqual(['abc']);
  });

  it('applies external patches through the callback and reports the new revision', () => {
    const sent: any[] = [];
    const applied: string[] = [];
    const adapter = new EditorSyncAdapter({
      postMessage: (message) => sent.push(message),
      getSettings: () => ({ fullWidth: true, tocVisible: false, tableWrap: false }),
      onSnapshot: (content) => applied.push(content),
      onExternalContent: (content, _patches, revision) => { applied.push(`${revision}:${content}`); return true; },
    });
    adapter.handleMessage({ type: 'documentSnapshot', documentId: 'doc', revision: 1, content: 'abc', contentHash: 'ignored' });
    adapter.handleMessage({ type: 'documentPatched', documentId: 'doc', baseRevision: 1, revision: 2, edits: [{ from: 1, to: 2, insert: 'B' }], resultHash: hashContent('aBc'), source: 'external' });
    expect(applied).toEqual(['abc', '2:aBc']);
  });
});
