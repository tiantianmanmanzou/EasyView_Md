/**
 * Main export logic: generate a standalone HTML from a ProseMirror EditorView.
 *
 * Uses DOMSerializer to serialize the document, then post-processes:
 * - Code blocks: highlighted with Refractor (pre-rendered <span> tokens)
 * - Mermaid blocks: converted to <pre class="mermaid"> with data-source
 * - TOC: extracted from headings (h1-h6)
 * - Frontmatter: rendered as styled key-value table
 * - Cleanup: remove contenteditable, data-original-src, etc.
 */

import { DOMSerializer } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import refractor from 'refractor/core';
import yaml from 'js-yaml';
import { schema } from '../../../editor/EditorSchema';
import { getRefractorLangForLanguage, getLoaderForLanguage } from '../../../editor/lib/CodeLanguages';
import { buildTemplate, type TemplateOptions } from './ExportTemplate';
import { highlightCodeBlocks } from './HtmlCodeHighlighting';
import { processMermaidBlocks, processPlantUmlBlocks, renderMathBlocks, processHtmlComments, processFootnotes, renderTocBlocks, processTableKeywords } from './HtmlContentProcessors';
import type { TocEntry } from './HtmlContentProcessors';
import { cleanupDom, escapeHtml } from './HtmlDomCleanup';

export interface ExportImage {
  originalSrc: string;
  exportFilename: string;
  isExternal: boolean;
}

export interface ExportResult {
  html: string;
  images: ExportImage[];
}

/**
 * Generate a complete standalone HTML string from the current editor state.
 */
export async function generateStandaloneHtml(
  view: EditorView,
  options: { title: string; isDark: boolean }
): Promise<ExportResult> {
  const doc = view.state.doc;

  // Serialize ProseMirror document to DOM
  const serializer = DOMSerializer.fromSchema(schema);
  const fragment = serializer.serializeFragment(doc.content);

  // Create a temporary container
  const container = document.createElement('div');
  container.appendChild(fragment);

  // Collect all languages used, ensure they're loaded
  await preloadLanguages(container);

  // Post-process code blocks with Refractor highlighting
  highlightCodeBlocks(container);

  // Post-process Mermaid blocks
  const hasMermaid = processMermaidBlocks(container);
  processPlantUmlBlocks(container);

  // Extract headings for TOC and assign IDs
  const toc = extractHeadings(container);

  // Render frontmatter as styled key-value table
  renderFrontmatter(container);

  // Render math blocks with KaTeX
  const hasMath = renderMathBlocks(container);

  // Post-process HTML comments
  processHtmlComments(container);

  // Post-process footnotes: add IDs and anchor links for navigation
  processFootnotes(container);

  // Render inline [[_TOC_]] blocks with actual heading links
  renderTocBlocks(container, toc);

  // Highlight standalone keywords in table cells
  processTableKeywords(container);

  // Clean up editor artifacts and collect image info
  const images = cleanupDom(container);

  // Build TOC HTML
  const tocHtml = buildTocHtml(toc);

  // Build the full template
  const contentHtml = container.innerHTML;
  const html = buildTemplate(contentHtml, tocHtml, {
    title: options.title,
    isDark: options.isDark,
    hasMermaid,
    hasMath,
  });

  return { html, images };
}

/**
 * Pre-load all Refractor languages used in code blocks.
 */
async function preloadLanguages(container: HTMLElement): Promise<void> {
  const codeBlocks = container.querySelectorAll('pre code[class*="language-"]');
  const languages = new Set<string>();

  codeBlocks.forEach((code) => {
    const className = code.className;
    const match = className.match(/language-(\S+)/);
    if (match) {
      languages.add(match[1]);
    }
  });

  const promises: Promise<void>[] = [];
  languages.forEach((lang) => {
    if (lang === 'mermaid' || lang === 'mermaidjs') return;
    const refractorLang = getRefractorLangForLanguage(lang);
    if (refractorLang && !refractor.registered(refractorLang)) {
      const loader = getLoaderForLanguage(lang);
      if (loader) {
        promises.push(
          loader()
            .then((syntax) => { refractor.register(syntax); })
            .catch((err) => { console.warn(`Failed to load language ${lang}:`, err); })
        );
      }
    }
  });

  await Promise.all(promises);
}

/**
 * Generate a slug from heading text — same algorithm as headingToSlug.ts
 * so that anchor links (#h-...) in the document work correctly.
 */
function headingSlug(text: string): string {
  let slug = 'h-' + text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // Keep letters (incl. Cyrillic), digits, spaces, hyphens
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug || slug === 'h-') slug = 'h-heading';
  return slug;
}

/**
 * Extract headings from the container, assign IDs, return TOC entries.
 * Uses the same slug algorithm as the editor's anchorPlugin so that
 * in-document anchor links (#h-...) resolve correctly in the export.
 */
function extractHeadings(container: HTMLElement): TocEntry[] {
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const toc: TocEntry[] = [];
  const usedIds = new Set<string>();

  headings.forEach((heading) => {
    const text = heading.textContent?.trim() || '';
    const level = parseInt(heading.tagName.charAt(1), 10);

    const baseId = headingSlug(text);

    // Ensure uniqueness (same logic as anchorPlugin: -1, -2, ...)
    let uniqueId = baseId;
    let counter = 1;
    while (usedIds.has(uniqueId)) {
      uniqueId = `${baseId}-${counter}`;
      counter++;
    }
    usedIds.add(uniqueId);

    heading.id = uniqueId;
    toc.push({ id: uniqueId, text, level });
  });

  return toc;
}

/**
 * Build TOC HTML from entries.
 */
function buildTocHtml(entries: TocEntry[]): string {
  return entries
    .map((entry) =>
      `<li class="toc-item" data-level="${entry.level}"><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`
    )
    .join('\n');
}

/**
 * Render frontmatter as a styled key-value table (matching the editor display).
 */
function renderFrontmatter(container: HTMLElement): void {
  const frontmatters = container.querySelectorAll('pre.frontmatter');
  frontmatters.forEach((pre) => {
    const text = pre.textContent || '';
    if (!text.trim()) {
      pre.remove();
      return;
    }

    // Parse YAML
    let data: Record<string, any> = {};
    try {
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, any>;
      }
    } catch {
      // Fallback: show as raw YAML code block
      data = {};
    }

    // Build the frontmatter view
    const view = document.createElement('div');
    view.className = 'frontmatter-export';

    // Header
    const header = document.createElement('div');
    header.className = 'frontmatter-export-header';
    const label = document.createElement('span');
    label.className = 'frontmatter-export-label';
    label.textContent = 'FRONTMATTER';
    header.appendChild(label);
    view.appendChild(header);

    const keys = Object.keys(data);
    if (keys.length === 0) {
      // Fallback: raw YAML display
      const raw = document.createElement('pre');
      raw.className = 'frontmatter-export-raw';
      const code = document.createElement('code');
      code.textContent = text.trim();
      raw.appendChild(code);
      view.appendChild(raw);
    } else {
      // Key-value grid
      const grid = document.createElement('div');
      grid.className = 'frontmatter-export-grid';

      for (const key of keys) {
        const value = data[key];
        const row = document.createElement('div');
        row.className = 'frontmatter-export-row';

        const keyEl = document.createElement('div');
        keyEl.className = 'frontmatter-export-key';
        keyEl.textContent = key;

        const valEl = document.createElement('div');
        valEl.className = 'frontmatter-export-value';
        renderFrontmatterValue(valEl, value);

        row.appendChild(keyEl);
        row.appendChild(valEl);
        grid.appendChild(row);
      }

      view.appendChild(grid);
    }

    pre.replaceWith(view);
  });
}

/**
 * Render a frontmatter value into a container element.
 */
function renderFrontmatterValue(container: HTMLElement, value: any): void {
  if (value === null || value === undefined) {
    const el = document.createElement('span');
    el.className = 'frontmatter-export-null';
    el.textContent = 'null';
    container.appendChild(el);
  } else if (typeof value === 'boolean') {
    const chip = document.createElement('span');
    chip.className = `frontmatter-export-bool frontmatter-export-bool-${value}`;
    chip.textContent = String(value);
    container.appendChild(chip);
  } else if (Array.isArray(value)) {
    const chips = document.createElement('div');
    chips.className = 'frontmatter-export-chips';
    for (const item of value) {
      const chip = document.createElement('span');
      chip.className = 'frontmatter-export-chip';
      chip.textContent = typeof item === 'object' ? JSON.stringify(item) : String(item);
      chips.appendChild(chip);
    }
    container.appendChild(chips);
  } else if (typeof value === 'object') {
    const code = document.createElement('code');
    code.className = 'frontmatter-export-nested';
    code.textContent = yaml.dump(value, { indent: 2, lineWidth: -1 }).trim();
    container.appendChild(code);
  } else {
    const text = String(value);
    if (text.includes('\n')) {
      const pre = document.createElement('span');
      pre.className = 'frontmatter-export-multiline';
      pre.textContent = text;
      container.appendChild(pre);
    } else {
      container.textContent = text;
    }
  }
}
