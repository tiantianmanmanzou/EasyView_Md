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

  it('ignores a same-revision snapshot so tab reactivation does not wipe undo', () => {
    const sent: any[] = [];
    const applied: string[] = [];
    const adapter = new EditorSyncAdapter({
      postMessage: (message) => sent.push(message),
      getSettings: () => ({ fullWidth: true, tocVisible: false, tableWrap: false }),
      onSnapshot: (content) => applied.push(content),
      onExternalContent: () => true,
    });
    adapter.handleMessage({ type: 'documentSnapshot', documentId: 'doc', revision: 3, content: '# live', contentHash: 'ignored', reason: 'initial' });
    adapter.handleMessage({ type: 'documentSnapshot', documentId: 'doc', revision: 3, content: '# live', contentHash: 'ignored', reason: 'visible' });
    expect(applied).toEqual(['# live']);
    expect(sent.filter((message) => message.type === 'snapshotApplied')).toHaveLength(2);
  });

  it('applies a same-revision snapshot when the host asks for a reload', () => {
    const applied: string[] = [];
    const adapter = new EditorSyncAdapter({
      postMessage: () => undefined,
      getSettings: () => ({ fullWidth: true, tocVisible: false, tableWrap: false }),
      onSnapshot: (content) => applied.push(content),
      onExternalContent: () => true,
    });
    adapter.handleMessage({ type: 'documentSnapshot', documentId: 'doc', revision: 1, content: '# a', contentHash: 'ignored', reason: 'initial' });
    adapter.handleMessage({ type: 'documentSnapshot', documentId: 'doc', revision: 1, content: '# a reloaded', contentHash: 'ignored', reason: 'reload' });
    expect(applied).toEqual(['# a', '# a reloaded']);
  });

  it('acknowledges a matching documentActivate without replaying content', () => {
    const sent: any[] = [];
    const applied: string[] = [];
    const adapter = new EditorSyncAdapter({
      postMessage: (message) => sent.push(message),
      getSettings: () => ({ fullWidth: true, tocVisible: false, tableWrap: false }),
      onSnapshot: (content) => applied.push(content),
      onExternalContent: () => true,
    });
    adapter.handleMessage({ type: 'documentSnapshot', documentId: 'doc', revision: 3, content: '# live', contentHash: hashContent('# live'), reason: 'initial' });
    adapter.handleMessage({ type: 'documentActivate', documentId: 'doc', revision: 3, contentHash: hashContent('# live'), reason: 'visible' });
    expect(applied).toEqual(['# live']);
    expect(sent.filter((message) => message.type === 'snapshotApplied')).toHaveLength(2);
    expect(sent.some((message) => message.type === 'requestResync')).toBe(false);
  });

  it('requests a resync when documentActivate cannot match a live session', () => {
    const sent: any[] = [];
    const adapter = new EditorSyncAdapter({
      postMessage: (message) => sent.push(message),
      getSettings: () => ({ fullWidth: true, tocVisible: false, tableWrap: false }),
      onSnapshot: () => undefined,
      onExternalContent: () => true,
    });
    adapter.handleMessage({ type: 'documentActivate', documentId: 'doc', revision: 1, contentHash: 'missing', reason: 'visible' });
    expect(sent).toEqual([{
      type: 'requestResync',
      documentId: 'doc',
      revision: 1,
      reason: 'Activate without a live document session',
    }]);
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
