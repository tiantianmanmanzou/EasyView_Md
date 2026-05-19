/**
 * File Header Bar — top bar with file name, TOC/collapse/width/zoom/source/export controls.
 * Extracted from index.ts as a standalone UI component.
 */

export interface FileHeaderDeps {
  postMessage: (msg: any) => void;
  getState: () => { isFullWidth: boolean; isTocVisible: boolean; isTableWrap: boolean; currentContent: string };
  setState: (patch: Partial<{ isFullWidth: boolean; isTocVisible: boolean; isTableWrap: boolean }>) => void;
  onSettingsChange: () => void;
}

export interface FileHeader {
  el: HTMLElement;
  setName: (name: string) => void;
  setCollapseHandler: (handler: () => void) => void;
  setTocHandler: (handler: () => void) => void;
  setExportHtmlLightHandler: (handler: () => void) => void;
  setExportHtmlDarkHandler: (handler: () => void) => void;
  setExportPdfLightHandler: (handler: () => void) => void;
  setExportPdfDarkHandler: (handler: () => void) => void;
  setSourceHandler: (handler: () => void) => void;
  setStageHandler: (handler: () => void) => void;
  setHistoryHandler: (handler: () => void) => void;
  getSourceBtn: () => HTMLElement;
  getHistoryBtn: () => HTMLElement;
}

export function createFileHeader(deps: FileHeaderDeps): FileHeader {
  const { postMessage, getState, setState, onSettingsChange } = deps;
  type ThemeMode = 'light' | 'dark';
  type AccentTheme = 'default' | 'blue' | 'orangeRed' | 'green' | 'purple';
  const accentThemes: Array<{ value: AccentTheme; label: string }> = [
    { value: 'default', label: 'Default text' },
    { value: 'blue', label: 'Blue' },
    { value: 'orangeRed', label: 'Orange red' },
    { value: 'green', label: 'Green' },
    { value: 'purple', label: 'Purple' },
  ];

  function readStoredThemeMode(): ThemeMode | null {
    try {
      const stored = localStorage.getItem('mdpre-zalman-theme');
      return stored === 'light' || stored === 'dark' ? stored : null;
    } catch {
      return null;
    }
  }

  function detectThemeMode(): ThemeMode {
    const stored = readStoredThemeMode();
    if (stored) return stored;
    if (document.body.classList.contains('vscode-light')) return 'light';
    if (document.body.classList.contains('vscode-dark')) return 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function readStoredAccentTheme(): AccentTheme {
    try {
      const stored = localStorage.getItem('mdpre-zalman-accent-theme') as AccentTheme | null;
      if (accentThemes.some((theme) => theme.value === stored)) return stored!;
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
    return 'default';
  }

  const bar = document.createElement('div');
  bar.className = 'file-header-bar';

  const postCurrentEdit = () => {
    const s = getState();
    postMessage({
      type: 'edit',
      content: s.currentContent,
      fullWidth: s.isFullWidth,
      tocVisible: s.isTocVisible,
      tableWrap: s.isTableWrap,
    });
  };

  const nameEl = document.createElement('span');
  nameEl.className = 'file-header-name';
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.title = 'Click to rename';

  nameEl.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Escape') {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
  });

  nameEl.addEventListener('blur', () => {
    const newName = nameEl.textContent?.trim();
    if (newName) {
      postMessage({ type: 'rename', newName });
    }
  });

  // Left group (TOC, collapse, width buttons)
  const leftGroup = document.createElement('div');
  leftGroup.className = 'file-header-actions file-header-actions-left';

  const tocBtn = document.createElement('button');
  tocBtn.className = 'file-header-btn';
  tocBtn.title = 'Toggle Table of Contents';
  tocBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="17" y2="18"/></svg>';
  leftGroup.appendChild(tocBtn);

  let allCollapsed = false;
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'file-header-btn';
  collapseBtn.title = 'Collapse all headings';
  collapseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  leftGroup.appendChild(collapseBtn);

  const widthBtn = document.createElement('button');
  widthBtn.className = 'file-header-btn';
  widthBtn.title = 'Expand to full width';
  widthBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  widthBtn.addEventListener('click', () => {
    const state = getState();
    const newFullWidth = !state.isFullWidth;
    setState({ isFullWidth: newFullWidth });
    document.getElementById('editor')?.classList.toggle('full-width', newFullWidth);
    widthBtn.classList.toggle('active', newFullWidth);
    widthBtn.title = newFullWidth ? 'Exit full width' : 'Expand to full width';
    widthBtn.innerHTML = newFullWidth
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
    postCurrentEdit();
    onSettingsChange();
  });
  leftGroup.appendChild(widthBtn);

  const tableWrapBtn = document.createElement('button');
  tableWrapBtn.className = 'file-header-btn active'; // default: active (enabled)
  tableWrapBtn.title = 'Disable table word wrap';
  tableWrapBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" y1="18" x2="10" y2="18"/></svg>';
  tableWrapBtn.addEventListener('click', () => {
    const state = getState();
    const newTableWrap = !state.isTableWrap;
    setState({ isTableWrap: newTableWrap });
    document.getElementById('editor')?.classList.toggle('table-wrap', newTableWrap);
    tableWrapBtn.classList.toggle('active', newTableWrap);
    tableWrapBtn.title = newTableWrap ? 'Disable table word wrap' : 'Enable table word wrap';
    postCurrentEdit();
    onSettingsChange();
  });
  leftGroup.appendChild(tableWrapBtn);

  // Zoom controls
  const ZOOM_MIN = 50, ZOOM_MAX = 200, ZOOM_STEP = 10;
  let zoomLevel = 100;
  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'file-header-zoom';
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'file-header-btn file-header-zoom-btn';
  zoomOutBtn.title = 'Zoom out';
  zoomOutBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'file-header-zoom-label';
  zoomLabel.textContent = '100%';
  zoomLabel.title = 'Click to reset zoom';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'file-header-btn file-header-zoom-btn';
  zoomInBtn.title = 'Zoom in';
  zoomInBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  function applyZoom(level: number) {
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
    zoomLabel.textContent = `${zoomLevel}%`;
    const scrollArea = document.getElementById('editor-scroll-area');
    if (scrollArea) scrollArea.style.fontSize = `${zoomLevel}%`;
    zoomOutBtn.classList.toggle('disabled', zoomLevel <= ZOOM_MIN);
    zoomInBtn.classList.toggle('disabled', zoomLevel >= ZOOM_MAX);
  }
  zoomOutBtn.addEventListener('click', () => applyZoom(zoomLevel - ZOOM_STEP));
  zoomInBtn.addEventListener('click', () => applyZoom(zoomLevel + ZOOM_STEP));
  zoomLabel.addEventListener('click', () => applyZoom(100));
  zoomGroup.appendChild(zoomOutBtn);
  zoomGroup.appendChild(zoomLabel);
  zoomGroup.appendChild(zoomInBtn);
  leftGroup.appendChild(zoomGroup);
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      applyZoom(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }
  }, { passive: false });

  // Right group
  const rightGroup = document.createElement('div');
  rightGroup.className = 'file-header-actions file-header-actions-right';
  const stageBtn = document.createElement('button');
  stageBtn.className = 'file-header-btn';
  stageBtn.title = 'Stage current file';
  stageBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  rightGroup.appendChild(stageBtn);

  const historyBtn = document.createElement('button');
  historyBtn.className = 'file-header-btn';
  historyBtn.title = 'Toggle history panel';
  historyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  rightGroup.appendChild(historyBtn);

  const sourceBtn = document.createElement('button');
  sourceBtn.className = 'file-header-btn';
  sourceBtn.title = 'Open native source mode with inline suggestions (Ctrl+/)';
  sourceBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  rightGroup.appendChild(sourceBtn);

  // Export dropdown
  const exportWrapper = document.createElement('div');
  exportWrapper.className = 'file-header-export-wrapper';
  const exportBtn = document.createElement('button');
  exportBtn.className = 'file-header-btn';
  exportBtn.title = 'Export';
  exportBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  exportWrapper.appendChild(exportBtn);

  const exportDropdown = document.createElement('div');
  exportDropdown.className = 'file-header-dropdown';

  const exportHtmlLightItem = document.createElement('button');
  exportHtmlLightItem.className = 'file-header-dropdown-item';
  exportHtmlLightItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Export HTML (Light)';

  const exportHtmlDarkItem = document.createElement('button');
  exportHtmlDarkItem.className = 'file-header-dropdown-item';
  exportHtmlDarkItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Export HTML (Dark)';

  const exportPdfLightItem = document.createElement('button');
  exportPdfLightItem.className = 'file-header-dropdown-item';
  exportPdfLightItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Export PDF (Light)';

  const exportPdfDarkItem = document.createElement('button');
  exportPdfDarkItem.className = 'file-header-dropdown-item';
  exportPdfDarkItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Export PDF (Dark)';

  exportDropdown.appendChild(exportHtmlLightItem);
  exportDropdown.appendChild(exportHtmlDarkItem);
  exportDropdown.appendChild(exportPdfLightItem);
  exportDropdown.appendChild(exportPdfDarkItem);
  exportWrapper.appendChild(exportDropdown);
  rightGroup.appendChild(exportWrapper);

  const themeToggleBtn = document.createElement('button');
  themeToggleBtn.className = 'file-header-btn';
  let themeMode: ThemeMode = detectThemeMode();
  function applyThemeMode(mode: ThemeMode) {
    themeMode = mode;
    document.body.classList.toggle('mdpre-light', mode === 'light');
    document.body.classList.toggle('mdpre-dark', mode === 'dark');
    try {
      localStorage.setItem('mdpre-zalman-theme', mode);
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
    themeToggleBtn.classList.toggle('active', mode === 'dark');
    themeToggleBtn.title = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggleBtn.innerHTML = mode === 'dark'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z"/></svg>';
    window.dispatchEvent(new CustomEvent('inlinemd:themeChanged', {
      detail: { mode, isDark: mode === 'dark' },
    }));
  }
  themeToggleBtn.addEventListener('click', () => {
    applyThemeMode(themeMode === 'dark' ? 'light' : 'dark');
  });
  applyThemeMode(themeMode);
  rightGroup.appendChild(themeToggleBtn);

  const accentSelect = document.createElement('select');
  accentSelect.className = 'file-header-accent-select';
  accentSelect.title = 'Choose editor text color theme';
  for (const theme of accentThemes) {
    const option = document.createElement('option');
    option.value = theme.value;
    option.textContent = theme.label;
    accentSelect.appendChild(option);
  }
  function applyAccentTheme(theme: AccentTheme) {
    document.body.dataset.mdpreAccent = theme;
    accentSelect.value = theme;
    try {
      localStorage.setItem('mdpre-zalman-accent-theme', theme);
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
  }
  accentSelect.addEventListener('change', () => {
    applyAccentTheme(accentSelect.value as AccentTheme);
  });
  applyAccentTheme(readStoredAccentTheme());
  rightGroup.appendChild(accentSelect);

  // Toggle dropdown on button click
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    exportDropdown.classList.remove('open');
  });

  // Close dropdown on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') exportDropdown.classList.remove('open');
  });

  bar.appendChild(leftGroup);
  bar.appendChild(nameEl);
  bar.appendChild(rightGroup);

  return {
    el: bar,
    setName(name: string) { nameEl.textContent = name; },
    setCollapseHandler(handler: () => void) {
      collapseBtn.addEventListener('click', () => {
        allCollapsed = !allCollapsed;
        collapseBtn.title = allCollapsed ? 'Expand all headings' : 'Collapse all headings';
        collapseBtn.innerHTML = allCollapsed
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
        collapseBtn.classList.toggle('active', allCollapsed);
        handler();
      });
    },
    setTocHandler(handler: () => void) {
      tocBtn.addEventListener('click', () => {
        handler();
        const state = getState();
        const newTocVisible = !state.isTocVisible;
        setState({ isTocVisible: newTocVisible });
        tocBtn.classList.toggle('active', newTocVisible);
        tocBtn.title = newTocVisible ? 'Hide Table of Contents' : 'Toggle Table of Contents';
        postCurrentEdit();
        onSettingsChange();
      });
    },
    setExportHtmlLightHandler(handler: () => void) {
      exportHtmlLightItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportHtmlDarkHandler(handler: () => void) {
      exportHtmlDarkItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportPdfLightHandler(handler: () => void) {
      exportPdfLightItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportPdfDarkHandler(handler: () => void) {
      exportPdfDarkItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setSourceHandler(handler: () => void) { sourceBtn.addEventListener('click', handler); },
    setStageHandler(handler: () => void) { stageBtn.addEventListener('click', handler); },
    setHistoryHandler(handler: () => void) { historyBtn.addEventListener('click', handler); },
    getSourceBtn() { return sourceBtn; },
    getHistoryBtn() { return historyBtn; },
  };
}
