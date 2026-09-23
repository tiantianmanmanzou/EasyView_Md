export type DocumentSyncState =
  | 'synced'
  | 'awaitingAck'
  | 'awaitingAckWithBufferedEdits'
  | 'resyncing'
  | 'conflict'
  | 'disposed';
