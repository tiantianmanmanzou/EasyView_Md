// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../css-modules.d.ts" />
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../x-data-spreadsheet-dist.d.ts" />
import * as React from 'react';
import { createPortal } from 'react-dom';
import type { PreviewWriteResult } from '@easyview/contracts';
import type { XsSpreadsheetFactory, XsSpreadsheetInstance } from '../spreadsheet/xSpreadsheetTypes';
import type { PreviewHost } from '../types';
import {
  extension,
  h,
  loadingElement,
  UniversalFilePreview,
  ViewerError,
  type ViewerProps,
} from './shared';
import {
  DocumentChromeActions,
  DocumentRouteShell,
  useDocumentRouteTheme,
  useToolbarPinned,
} from './DocumentRouteChrome';
import { isEditableSpreadsheetFile } from '../spreadsheet/editableFormats';
import {
  applyXSpreadsheetTheme,
  spreadsheetDefaultStyle,
} from '../spreadsheet/spreadsheetTheme';
import { attachSpreadsheetWheelNormalization } from '../spreadsheet/spreadsheetWheel';
import {
  workbookBytesToXsSheets,
  xsSheetsToWorkbookBytes,
} from '../spreadsheet/xSpreadsheetBridge';

/** x-data-spreadsheet hardcodes these when computing sheet viewHeight (data_proxy). */
const XS_LIBRARY_TOOLBAR_HEIGHT_PX = 41;
const XS_LIBRARY_BOTTOMBAR_HEIGHT_PX = 41;

export interface SpreadsheetViewerProps extends ViewerProps {
  host?: PreviewHost;
}

/**
 * Map mount size → library view.height() so canvas fills the space between the
 * real CSS toolbar/bottombar (which are shorter, and toolbar may be display:none).
 */
function spreadsheetViewHeight(mount: HTMLElement | null | undefined): number {
  if (!mount) return 600;
  const toolbar = mount.querySelector('.x-spreadsheet-toolbar') as HTMLElement | null;
  const bottombar = mount.querySelector('.x-spreadsheet-bottombar') as HTMLElement | null;
  const toolbarVisible = !!toolbar && getComputedStyle(toolbar).display !== 'none';
  const bottomVisible = !!bottombar && getComputedStyle(bottombar).display !== 'none';
  const toolbarH = toolbarVisible ? toolbar.offsetHeight : 0;
  const bottomH = bottomVisible ? bottombar.offsetHeight : 0;
  // Library always subtracts 41 for each enabled chrome flag (both stay true here).
  return mount.clientHeight - toolbarH - bottomH
    + XS_LIBRARY_TOOLBAR_HEIGHT_PX
    + XS_LIBRARY_BOTTOMBAR_HEIGHT_PX;
}

/**
 * Spreadsheet route:
 * - .xlsx/.xlsm with write host → editable x-spreadsheet (rich toolbar + save)
 * - .xls / .ods / .csv / .tsv / others → UniversalFilePreview (same chrome as PDF)
 */
export function SpreadsheetViewer({ descriptor, host }: SpreadsheetViewerProps): React.ReactElement {
  if (!isEditableSpreadsheetFile(descriptor.fileName) || !host?.writeBytes) {
    return h(UniversalFilePreview, { descriptor, loadingLabel: '正在加载表格预览器…' });
  }
  return h(SpreadsheetEditor, { descriptor, host });
}

function SpreadsheetEditor({ descriptor, host }: { descriptor: ViewerProps['descriptor']; host: PreviewHost }): React.ReactElement {
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const sheetRef = React.useRef<XsSpreadsheetInstance | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [chromeSlot, setChromeSlot] = React.useState<HTMLElement | null>(null);
  const { themeMode, cycleTheme, viewerVars } = useDocumentRouteTheme(descriptor.relativePath);
  const { pinnedOpen, togglePinned } = useToolbarPinned();
  const themeModeRef = React.useRef(themeMode);
  themeModeRef.current = themeMode;

  React.useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let detachWheel: (() => void) | null = null;

    async function boot(): Promise<void> {
      setLoading(true);
      setError(null);
      setDirty(false);
      setSaveMessage(null);
      setChromeSlot(null);
      try {
        const response = await fetch(descriptor.contentUrl);
        if (!response.ok) throw new Error(`无法读取表格文件（HTTP ${response.status}）`);
        const bytes = await response.arrayBuffer();
        const sheets = await workbookBytesToXsSheets(bytes);
        if (disposed || !mountRef.current) return;

        const SpreadsheetModule = await import('x-data-spreadsheet/dist/xspreadsheet.js');
        await import('x-data-spreadsheet/dist/xspreadsheet.css');
        if (!document.getElementById('easyview-xlsx-edge-fix')) {
          const style = document.createElement('style');
          style.id = 'easyview-xlsx-edge-fix';
          style.textContent = `
.preview-spreadsheet-editor,
.preview-spreadsheet-mount,
.preview-spreadsheet-editor .x-spreadsheet,
.preview-spreadsheet-editor .x-spreadsheet-sheet,
.preview-spreadsheet-editor .x-spreadsheet-table,
.preview-spreadsheet-editor .x-spreadsheet-overlayer,
.preview-spreadsheet-editor .x-spreadsheet-bottombar,
.preview-spreadsheet-editor .x-spreadsheet-toolbar,
html, body, .preview-root, .preview-shell, .preview-content {
  border-left: 0 !important;
  margin-left: 0 !important;
  padding-left: 0 !important;
  outline: none !important;
  box-shadow: none !important;
  scrollbar-gutter: auto !important;
}
.preview-spreadsheet-editor .x-spreadsheet,
.preview-spreadsheet-editor .x-spreadsheet-sheet {
  background: var(--file-viewer-bg, #fff) !important;
}`;
          document.head.appendChild(style);
        }
        const createSpreadsheet = resolveXSpreadsheetFactory(SpreadsheetModule);
        mountRef.current.innerHTML = '';
        const spreadsheet = createSpreadsheet(mountRef.current, {
          mode: 'edit',
          showToolbar: true,
          showGrid: true,
          showContextmenu: true,
          showBottomBar: true,
          style: spreadsheetDefaultStyle(themeModeRef.current),
          view: {
            // Library subtracts fixed 41+41; compensate from measured CSS chrome
            // (toolbar may be collapsed to display:none — fixed 30px math left a bottom gap).
            height: () => spreadsheetViewHeight(mountRef.current),
            width: () => mountRef.current?.clientWidth || 800,
          },
        });
        spreadsheet.loadData(sheets);
        spreadsheet.change(() => {
          if (!disposed) setDirty(true);
        });
        sheetRef.current = spreadsheet;
        applyXSpreadsheetTheme(spreadsheet, themeModeRef.current);
        detachWheel = attachSpreadsheetWheelNormalization(mountRef.current);

        // Append EasyView chrome after formatting buttons so the whole strip can center as one group.
        const toolbar = mountRef.current.querySelector('.x-spreadsheet-toolbar');
        if (toolbar) {
          let slot = toolbar.querySelector('[data-easyview-spreadsheet-chrome]') as HTMLElement | null;
          if (!slot) {
            slot = document.createElement('div');
            slot.setAttribute('data-easyview-spreadsheet-chrome', '');
          }
          const btns = toolbar.querySelector('.x-spreadsheet-toolbar-btns');
          if (btns?.nextSibling) toolbar.insertBefore(slot, btns.nextSibling);
          else if (btns) toolbar.appendChild(slot);
          else toolbar.appendChild(slot);
          if (!disposed) setChromeSlot(slot);
        }

        window.setTimeout(() => {
          if (disposed) return;
          spreadsheet.reRender?.();
          window.dispatchEvent(new Event('resize'));
        }, 0);
        resizeObserver = new ResizeObserver(() => {
          spreadsheet.reRender?.();
        });
        resizeObserver.observe(mountRef.current);
        if (!disposed) setLoading(false);
      } catch (reason) {
        if (!disposed) {
          setError(reason);
          setLoading(false);
        }
      }
    }

    void boot();
    return () => {
      disposed = true;
      detachWheel?.();
      detachWheel = null;
      resizeObserver?.disconnect();
      sheetRef.current = null;
      setChromeSlot(null);
      if (mountRef.current) mountRef.current.innerHTML = '';
    };
  }, [descriptor.contentUrl, descriptor.sessionId]);

  React.useEffect(() => {
    applyXSpreadsheetTheme(sheetRef.current, themeMode);
  }, [themeMode]);

  // Toolbar collapse toggles display:none — remeasure viewHeight so the sheet fills the gap.
  React.useEffect(() => {
    const spreadsheet = sheetRef.current;
    if (!spreadsheet) return;
    window.requestAnimationFrame(() => {
      spreadsheet.reRender?.();
      window.dispatchEvent(new Event('resize'));
    });
  }, [pinnedOpen]);

  const save = React.useCallback(async () => {
    if (!host.writeBytes || !sheetRef.current || saving) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const bytes = await xsSheetsToWorkbookBytes(sheetRef.current.getData());
      const result: PreviewWriteResult = await host.writeBytes(descriptor.sessionId, bytes);
      setDirty(false);
      setSaveMessage(`已保存 · ${(result.size / 1024).toFixed(result.size >= 10240 ? 0 : 1)} KB`);
    } catch (reason) {
      setSaveMessage(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [descriptor.sessionId, host, saving]);

  const toolbarChrome = chromeSlot && pinnedOpen
    ? createPortal(
        h(DocumentChromeActions, {
          embedded: true,
          themeMode,
          onCycleTheme: cycleTheme,
          onTogglePinned: togglePinned,
          dirty,
          saving,
          saveMessage,
          onSave: () => { void save(); },
        }),
        chromeSlot,
      )
    : null;

  if (error) return h(ViewerError, { error });

  return h(DocumentRouteShell, {
    className: 'preview-spreadsheet-editor',
    themeMode,
    style: viewerVars,
    'data-ext': extension(descriptor.fileName),
    embedChrome: true,
    pinnedOpen,
    onTogglePinned: togglePinned,
    onCycleTheme: cycleTheme,
  },
    h('div', {
      className: 'preview-spreadsheet-mount',
      ref: mountRef,
      'aria-busy': loading || undefined,
    }),
    toolbarChrome,
    loading ? h('div', { className: 'preview-spreadsheet-loading' }, loadingElement('正在加载表格编辑器…')) : null,
  );
}


function resolveXSpreadsheetFactory(moduleValue: unknown): XsSpreadsheetFactory {
  const fromWindow = (window as unknown as Window & { x_spreadsheet?: XsSpreadsheetFactory }).x_spreadsheet;
  if (typeof fromWindow === 'function') return fromWindow;

  const mod = moduleValue as { default?: unknown } | XsSpreadsheetFactory | null;
  const candidate = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
  if (typeof candidate === 'function') {
    const fn = candidate as XsSpreadsheetFactory & { prototype?: { loadData?: unknown } };
    if (fn.prototype && typeof fn.prototype.loadData === 'function') {
      return (container, options) => new (fn as unknown as new (el: HTMLElement, opts?: Record<string, unknown>) => XsSpreadsheetInstance)(container, options);
    }
    return fn;
  }
  throw new Error('x-spreadsheet 未能正确加载（缺少构造函数）');
}
