import { describe, expect, it } from 'vitest';
import { DocumentSyncSession, type SyncOutboundMessage } from '../documentSyncSession';
import { hashContent } from '../contentHash';

describe('DocumentSyncSession', () => {
  it('allows one in-flight edit and buffers following edits', () => {
    const sent: SyncOutboundMessage[] = [];
    const session = new DocumentSyncSession({ documentId: 'doc', initialContent: 'abc', onSend: (message) => sent.push(message) });
    const first = session.applyLocalEdits([{ from: 1, to: 2, insert: 'X' }])!;
    session.applyLocalEdits([{ from: 2, to: 3, insert: 'Y' }]);

    expect(sent).toHaveLength(1);
    expect(session.snapshot.state).toBe('awaitingAckWithBufferedEdits');
    expect(session.snapshot.canonicalContent).toBe('aXY');

    session.handleAck({ type: 'editsApplied', documentId: 'doc', clientEditId: first.clientEditId, revision: 1, resultHash: first.resultHash });
    expect(sent).toHaveLength(2);
    expect(session.snapshot.inFlight?.baseRevision).toBe(1);
    expect(session.snapshot.canonicalContent).toBe('aXY');
  });


  it('rebases buffered offsets by diffing the final optimistic shadow after ack', () => {
    const sent: SyncOutboundMessage[] = [];
    const session = new DocumentSyncSession({ documentId: 'doc', initialContent: 'abc', onSend: (message) => sent.push(message) });
    const first = session.applyLocalEdits([{ from: 0, to: 0, insert: 'long-' }])!;
    session.applyLocalEdits([{ from: 5, to: 6, insert: 'A' }]);
    expect(session.snapshot.canonicalContent).toBe('long-Abc');

    session.handleAck({ type: 'editsApplied', documentId: 'doc', clientEditId: first.clientEditId, revision: 1, resultHash: first.resultHash });
    const second = sent[1];
    expect(second).toMatchObject({ type: 'applyEdits', baseRevision: 1 });
    expect(session.snapshot.canonicalContent).toBe('long-Abc');
  });

  it('requests resync for a stale external patch and disposes cleanly', () => {
    const sent: SyncOutboundMessage[] = [];
    const session = new DocumentSyncSession({ documentId: 'doc', initialContent: 'abc', onSend: (message) => sent.push(message) });
    session.handleExternalPatch({ type: 'documentPatched', documentId: 'doc', baseRevision: 3, revision: 4, edits: [], resultHash: hashContent('abc') });
    expect(session.snapshot.state).toBe('resyncing');
    expect(sent[0]).toMatchObject({ type: 'resyncRequired', documentId: 'doc' });
    session.dispose();
    expect(session.snapshot.state).toBe('disposed');
    expect(() => session.applyLocalEdits([{ from: 0, to: 0, insert: 'x' }])).toThrow('disposed');
  });
});

it('rebases a non-overlapping external patch and detects an overlapping conflict', () => {
  const sent: SyncOutboundMessage[] = [];
  const session = new DocumentSyncSession({ documentId: 'doc', initialContent: 'abcdef', onSend: (message) => sent.push(message) });
  const first = session.applyLocalEdits([{ from: 0, to: 1, insert: 'A' }])!;
  session.handleExternalPatch({ type: 'documentPatched', documentId: 'doc', baseRevision: 0, revision: 1, edits: [{ from: 5, to: 6, insert: 'Z' }], resultHash: hashContent('abcdeZ') });
  expect(session.snapshot.state).toBe('awaitingAck');
  expect(session.snapshot.canonicalContent).toBe('AbcdeZ');
  session.handleAck({ type: 'editsApplied', documentId: 'doc', clientEditId: first.clientEditId, revision: 2, resultHash: first.resultHash });
  expect(session.snapshot.state).toBe('awaitingAck');
  expect(sent.filter((message) => message.type === 'resyncRequired')).toHaveLength(0);

  const conflict = new DocumentSyncSession({ documentId: 'conflict', initialContent: 'abcdef' });
  conflict.applyLocalEdits([{ from: 1, to: 2, insert: 'X' }]);
  conflict.handleExternalPatch({ type: 'documentPatched', documentId: 'conflict', baseRevision: 0, revision: 1, edits: [{ from: 1, to: 2, insert: 'Y' }], resultHash: hashContent('aYcdef') });
  expect(conflict.snapshot.state).toBe('conflict');
});

it('recovers from resync with a new canonical snapshot', () => {
  const session = new DocumentSyncSession({ documentId: 'doc', initialContent: 'old' });
  session.requestResync('test');
  session.applySnapshot('new', 8);
  expect(session.snapshot).toMatchObject({ state: 'synced', revision: 8, canonicalContent: 'new', bufferedEdits: 0 });
});
