import type { ReactElement } from 'react';
import type {
  ArchiveEntry,
  ArchiveEntryPreview,
  HttpPreviewRequest,
  HttpPreviewResponse,
  PreviewDescriptor,
  PreviewRoute,
  PreviewTextResult,
  PreviewWriteResult,
} from '@easyview/contracts';

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PreviewState {
  descriptor: PreviewDescriptor | null;
  status: PreviewStatus;
  error: string | null;
}

/** Host-injected actions consumed by viewers. Desktop/Extension adapt their APIs here. */
export interface PreviewHost {
  getState(): PreviewState;
  subscribe(listener: () => void): () => void;
  readText?(sessionId: string): Promise<PreviewTextResult>;
  /** Persist document-route bytes back to the source file (Excel first; Word/PPT later). */
  writeBytes?(sessionId: string, bytes: Uint8Array): Promise<PreviewWriteResult>;
  /**
   * Report whether the open preview has unsaved edits so the host can warn on
   * close / quit / switch-away.
   */
  setDirty?(dirty: boolean): void;
  /**
   * Register the active viewer's save implementation. Hosts call it when the
   * user chooses Save in an unsaved-changes dialog. Returns a disposer.
   */
  registerSaveHandler?(save: () => Promise<void>): () => void;
  /**
   * When set (e.g. VS Code custom editor), the Save button should ask the host
   * to run its native save path so the tab dirty state clears correctly.
   */
  requestHostSave?(): void;
  listArchive?(sessionId: string): Promise<ArchiveEntry[]>;
  openArchiveEntry?(sessionId: string, path: string): Promise<ArchiveEntryPreview>;
  exportArchiveEntry?(sessionId: string, path: string): Promise<void>;
  /** Extract the whole archive into a sibling folder named after it; resolves to that folder's name. */
  extractArchive?(sessionId: string): Promise<string>;
  decompileJava?(sessionId: string): Promise<string>;
  sendHttp?(request: HttpPreviewRequest): Promise<HttpPreviewResponse>;
}

export interface PreviewAssetConfig {
  /** Desktop's compact toolbar; its host owns the single visibility toggle outside the viewer. */
  compactToolbars?: boolean;
  /** Base URL for @file-viewer/react-full static assets (trailing slash). */
  fileViewerAssetBaseUrl: string;
  /** Base URL for @file-viewer/ppt assets (trailing slash). */
  pptAssetBaseUrl?: string;
  /** Absolute URL to the bundled legacy .doc worker module. */
  docWorkerUrl?: string;
  /** Standalone, cancellable XLSX parser bundle. Required by editable spreadsheets. */
  spreadsheetWorkerUrl?: string;
  /** Absolute URL to the HEIC decode host HTML (Desktop phase-2). */
  heicHostUrl?: string;
  /** Product + per-file preview theme storage. Defaults to localStorage adapter. */
  themeStorage?: import('./theme').PreviewThemeStorage;
}

export type PreviewViewerRenderer = (
  descriptor: PreviewDescriptor,
  host: PreviewHost,
) => ReactElement;

export type PreviewViewerLoader = () => Promise<PreviewViewerRenderer>;

export type PreviewExtraViewers = Partial<Record<PreviewRoute, PreviewViewerLoader>>;
