/**
 * HTML template for standalone export.
 * Builds a complete HTML document with embedded CSS and JS.
 */

import { EXPORT_CSS } from './ExportStyles';

/**
 * Embedded JavaScript for the standalone HTML page.
 * Handles: theme toggle, TOC interactions, full-width toggle, mermaid rendering.
 */
const EXPORT_JS = /* js */ `
(function() {
  'use strict';

  // ─── Theme ──────────────────────────────────────────────────────────────

  var html = document.documentElement;
  var themeBtn = document.getElementById('theme-toggle');
  var THEME_KEY = 'export-theme';

  function getStoredTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch(e) { return null; }
  }

  function setTheme(theme) {
    html.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) {}
    updateThemeIcon();
    reinitMermaid();
  }

  function updateThemeIcon() {
    if (!themeBtn) return;
    var isDark = html.getAttribute('data-theme') === 'dark';
    themeBtn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    themeBtn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  }

  // Apply stored or initial theme
  var stored = getStoredTheme();
  if (stored) { html.setAttribute('data-theme', stored); }
  updateThemeIcon();

  if (themeBtn) {
    themeBtn.addEventListener('click', function() {
      var current = html.getAttribute('data-theme');
      setTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  // ─── TOC ────────────────────────────────────────────────────────────────

  var tocSidebar = document.getElementById('toc-sidebar');
  var tocToggle = document.getElementById('toc-toggle');
  var tocFilter = document.getElementById('toc-filter');
  var tocItems = document.querySelectorAll('.toc-item');
  var mainLayout = document.querySelector('.main-layout');

  if (tocToggle && tocSidebar) {
    tocToggle.addEventListener('click', function() {
      tocSidebar.classList.toggle('hidden');
      var isHidden = tocSidebar.classList.contains('hidden');
      tocToggle.classList.toggle('active', !isHidden);
      if (mainLayout) mainLayout.classList.toggle('toc-hidden', isHidden);
    });
  }

  // Filter
  if (tocFilter) {
    tocFilter.addEventListener('input', function() {
      var q = this.value.toLowerCase();
      tocItems.forEach(function(item) {
        var text = item.textContent.toLowerCase();
        item.style.display = text.indexOf(q) !== -1 ? '' : 'none';
      });
    });
  }

  // Scroll tracking
  var headings = document.querySelectorAll('.document-content h1[id], .document-content h2[id], .document-content h3[id], .document-content h4[id], .document-content h5[id], .document-content h6[id]');
  var tocLinks = document.querySelectorAll('.toc-item a');
  var scrollTimer = null;
  var clickLocked = null; // ID of heading locked by user click
  var programmaticScroll = false;

  function setActiveLink(id) {
    tocLinks.forEach(function(link) { link.classList.remove('active'); });
    if (!id) return;
    var activeLink = document.querySelector('.toc-item a[href="#' + id + '"]');
    if (activeLink) {
      activeLink.classList.add('active');
      if (tocSidebar && !tocSidebar.classList.contains('hidden')) {
        var linkRect = activeLink.getBoundingClientRect();
        var sidebarRect = tocSidebar.getBoundingClientRect();
        if (linkRect.top < sidebarRect.top + 60 || linkRect.bottom > sidebarRect.bottom - 20) {
          activeLink.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
    }
  }

  function updateActiveHeading() {
    // If user recently clicked a TOC item, respect their choice
    if (clickLocked) {
      setActiveLink(clickLocked);
      return;
    }

    var current = null;
    var lastVisible = null;
    var scrollEl = document.querySelector('.content-area') || document.documentElement;
    var viewportHeight = scrollEl.clientHeight;
    var remainingScroll = scrollEl.scrollHeight - scrollEl.scrollTop - viewportHeight;

    headings.forEach(function(h) {
      var rect = h.getBoundingClientRect();
      if (rect.top <= 80) { current = h; }
      if (rect.top < viewportHeight && rect.bottom > 0) { lastVisible = h; }
    });

    // When near the bottom, use last visible heading
    if (remainingScroll < viewportHeight * 0.5 && lastVisible) { current = lastVisible; }

    setActiveLink(current ? current.id : null);
  }

  // TOC link click — scroll inside content-area card
  tocLinks.forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      var href = link.getAttribute('href');
      if (!href) return;
      var id = href.replace('#', '');
      var target = document.getElementById(id);
      if (target) {
        var ca = document.querySelector('.content-area');
        if (ca) {
          var targetTop = target.getBoundingClientRect().top - ca.getBoundingClientRect().top + ca.scrollTop;
          ca.scrollTo({ top: targetTop - 20, behavior: 'smooth' });
        }
      }
      clickLocked = id;
      programmaticScroll = true;
      setTimeout(function() { programmaticScroll = false; }, 600);
      setActiveLink(id);
    });
  });

  var contentArea = document.querySelector('.content-area');
  (contentArea || window).addEventListener('scroll', function() {
    // Manual scroll — unlock click lock
    if (clickLocked && !programmaticScroll) {
      clickLocked = null;
    }
    if (scrollTimer) return;
    scrollTimer = setTimeout(function() {
      scrollTimer = null;
      updateActiveHeading();
    }, 100);
  }, { passive: true });

  // Initial highlight
  updateActiveHeading();

  // ─── Full Width ─────────────────────────────────────────────────────────

  var widthBtn = document.getElementById('width-toggle');
  var content = document.getElementById('document-content');

  if (widthBtn && content) {
    widthBtn.addEventListener('click', function() {
      content.classList.toggle('full-width');
      var isWide = content.classList.contains('full-width');
      widthBtn.title = isWide ? 'Exit full width' : 'Expand to full width';
      widthBtn.innerHTML = isWide
        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
    });
  }

  // ─── Details Toggle ─────────────────────────────────────────────────────

  document.querySelectorAll('.details-summary').forEach(function(summary) {
    summary.addEventListener('click', function() {
      var block = summary.parentElement;
      if (block) block.classList.toggle('details-collapsed');
    });
  });

  // ─── Mermaid ────────────────────────────────────────────────────────────

  var mermaidBlocks = document.querySelectorAll('pre.mermaid');
  if (mermaidBlocks.length === 0) return; // No mermaid diagrams, skip initialization

  function reinitMermaid() {
    if (typeof mermaid === 'undefined') return;
    var isDark = html.getAttribute('data-theme') === 'dark';

    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: isDark ? 'dark' : 'base',
      darkMode: isDark,
      fontFamily: getComputedStyle(document.body).fontFamily || 'inherit',
      themeVariables: isDark ? undefined : {
        background: '#ffffff',
        mainBkg: '#f8fafc',
        secondBkg: '#eef6ff',
        tertiaryColor: '#f8fafc',
        primaryColor: '#f8fafc',
        primaryTextColor: '#1f2328',
        primaryBorderColor: '#8c959f',
        secondaryColor: '#eef6ff',
        secondaryTextColor: '#1f2328',
        secondaryBorderColor: '#8c959f',
        tertiaryTextColor: '#1f2328',
        tertiaryBorderColor: '#8c959f',
        nodeBorder: '#8c959f',
        clusterBkg: '#f6f8fa',
        clusterBorder: '#d0d7de',
        lineColor: '#8c959f',
        textColor: '#1f2328',
        edgeLabelBackground: '#ffffff',
        labelBackground: '#ffffff',
      },
    });

    mermaidBlocks.forEach(function(el, idx) {
      var source = el.getAttribute('data-source');
      if (!source) return;
      var id = 'mermaid-' + idx + '-' + Date.now();
      try {
        mermaid.render(id, source).then(function(result) {
          el.innerHTML = result.svg;
          if (result.bindFunctions) result.bindFunctions(el);
        }).catch(function(err) {
          el.textContent = 'Mermaid error: ' + err;
        });
      } catch(err) {
        el.textContent = 'Mermaid error: ' + err;
      }
    });
  }

  // Initialize mermaid on load
  if (typeof mermaid !== 'undefined') {
    reinitMermaid();
  } else {
    // Wait for mermaid CDN to load
    var checkMermaid = setInterval(function() {
      if (typeof mermaid !== 'undefined') {
        clearInterval(checkMermaid);
        reinitMermaid();
      }
    }, 200);
    // Stop checking after 10s
    setTimeout(function() { clearInterval(checkMermaid); }, 10000);
  }
})();
`;

export interface TemplateOptions {
  title: string;
  isDark: boolean;
  hasMermaid: boolean;
  hasMath: boolean;
}

/**
 * Build a complete standalone HTML document.
 */
export function buildTemplate(
  contentHtml: string,
  tocHtml: string,
  options: TemplateOptions
): string {
  const theme = options.isDark ? 'dark' : 'light';
  const escapedTitle = escapeHtml(options.title);

  const mermaidScript = options.hasMermaid
    ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>'
    : '';

  const katexCss = options.hasMath
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">'
    : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  ${katexCss}
  <style>${EXPORT_CSS}</style>
</head>
<body>
  <header class="export-header">
    <div class="header-left">
      <button id="toc-toggle" class="active" title="Toggle Table of Contents">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="17" y2="18"/></svg>
      </button>
    </div>
    <span class="header-title">${escapedTitle}</span>
    <div class="header-right">
      <button id="width-toggle" title="Expand to full width">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      </button>
      <button id="theme-toggle" title="Switch theme">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </header>
  <div class="main-layout">
    <nav class="toc-sidebar" id="toc-sidebar">
      <div class="toc-header">Contents</div>
      <input class="toc-filter" placeholder="Filter..." id="toc-filter">
      <ul class="toc-list" id="toc-list">${tocHtml}</ul>
    </nav>
    <main class="content-area">
      <article class="document-content" id="document-content">
${contentHtml}
      </article>
    </main>
  </div>
  ${mermaidScript}
  <script>${EXPORT_JS}<\/script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
