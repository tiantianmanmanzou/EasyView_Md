/**
 * Code Block Toolbar
 *
 * Creates toolbar decorations for code blocks and Mermaid diagrams,
 * including line numbers, copy/delete/edit buttons, and language selector.
 */

import { Decoration } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import copyToClipboard from 'copy-to-clipboard';
import padStart from 'lodash/padStart';
import { codeLanguages } from '../../../editor/lib/CodeLanguages';
import { isPlainTextCode } from '../../../editor/lib/CodeDetection';
import { pluginKey as mermaidPluginKey } from '../mermaid/MermaidPlugin';
import { pluginKey as plantumlPluginKey } from '../plantuml/PlantUmlPlugin';
import { pluginKey as externalDiagramPluginKey } from '../external-diagram/ExternalDiagramPlugin';
import { openLanguageDropdown } from './CodeBlockLanguageDropdown';

type DiagramKind = 'mermaid' | 'plantuml' | 'externalDiagram';

type DiagramToolbarConfig = {
  kind: DiagramKind;
  isEditing: boolean;
  diagramId?: string;
};

function getDiagramToggleIcon(isEditing: boolean): string {
  return isEditing
    ? `
      <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 5c5.5 0 9.5 4.5 10.7 6-.9 1.4-4.8 8-10.7 8S2.5 12.4 1.3 11C2.5 9.5 6.5 5 12 5zm0 2C8 7 4.8 9.7 3.5 11 4.8 12.3 8 17 12 17s7.2-4.7 8.5-6C19.2 9.7 16 7 12 7zm0 2.5A3.5 3.5 0 1 1 12 16a3.5 3.5 0 0 1 0-7zm0 2A1.5 1.5 0 1 0 12 15a1.5 1.5 0 0 0 0-3z"/>
      </svg>
    `
    : `
      <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
      </svg>
    `;
}

function syncDiagramToggleButton(button: HTMLButtonElement, isEditing: boolean): void {
  button.setAttribute('aria-label', isEditing ? 'Preview' : 'Edit');
  button.innerHTML = getDiagramToggleIcon(isEditing);
}

function getDiagramPluginKey(kind: DiagramKind) {
  if (kind === 'plantuml') return plantumlPluginKey;
  if (kind === 'externalDiagram') return externalDiagramPluginKey;
  return mermaidPluginKey;
}

function getDiagramWrapperClass(kind: DiagramKind): string {
  if (kind === 'plantuml') return 'plantuml-diagram-wrapper';
  if (kind === 'externalDiagram') return 'external-diagram-wrapper';
  return 'mermaid-diagram-wrapper';
}

function getDiagramWrapperIdPrefix(kind: DiagramKind): string {
  if (kind === 'plantuml') return 'plantuml-diagram-wrapper-';
  if (kind === 'externalDiagram') return 'external-diagram-wrapper-';
  return 'mermaid-diagram-wrapper-';
}

export function createLineNumbersDecorations(
  node: ProsemirrorNode,
  pos: number,
  diagram: DiagramToolbarConfig | null,
): Decoration[] {
  if (isPlainTextCode(node)) {
    return [];
  }

  const text = node.textContent;

  // Count lines correctly: empty text = 1 line, text with content = count newlines + 1
  // But if text ends with \n, don't count the trailing empty line
  let lineCount = 1;
  if (text) {
    // Count newlines in text
    const newlineCount = (text.match(/\n/g) || []).length;
    lineCount = newlineCount + 1;

    // If text ends with newline, the last "line" is empty, don't count it
    if (text.endsWith('\n') && text.length > 1) {
      lineCount = newlineCount;
    }
  }

  const gutterWidth = String(lineCount).length;

  const lineNumbers = new Array(lineCount)
    .fill(0)
    .map((_, i) => padStart(`${i + 1}`, gutterWidth, ' '))
    .join('\n');

  const diagramMode = diagram ? (diagram.isEditing ? `${diagram.kind}-editing` : `${diagram.kind}-preview`) : '';
  const style = [
    `--line-number-gutter-width: ${gutterWidth}`,
    diagram ? `display:${diagram.isEditing ? 'block' : 'none'}` : '',
  ].filter(Boolean).join(';');

  // Add node decoration to set attributes on the code block wrapper
  // Note: Don't use 'class' as it will overwrite existing classes from toDOM
  return [
    Decoration.node(pos, pos + node.nodeSize, {
      'data-line-numbers': lineNumbers,
      'data-gutter-width': String(gutterWidth),
      'data-diagram-mode': diagramMode || undefined,
      style,
    }),
  ];
}

export function createToolbarDecoration(
  node: ProsemirrorNode,
  pos: number,
  codeBlockPos: number,
  view: EditorView | null,
  diagram: DiagramToolbarConfig | null,
): Decoration {
  const toolbar = document.createElement('div');
  toolbar.className = 'code-block-toolbar';
  toolbar.contentEditable = 'false';

  if (diagram && view && diagram.diagramId) {
    const editButton = document.createElement('button');
    editButton.className = 'code-block-toolbar-button';
    syncDiagramToggleButton(editButton, diagram.isEditing);

    editButton.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    editButton.addEventListener('click', (e) => {
      e.stopPropagation();

      if (!view) return;

      const activePluginKey = getDiagramPluginKey(diagram.kind);
      const currentState = activePluginKey.getState(view.state);
      const isCurrentlyEditing = currentState?.editingId === diagram.diagramId;

      const newEditingId = isCurrentlyEditing ? undefined : diagram.diagramId;
      syncDiagramToggleButton(editButton, !isCurrentlyEditing);
      const tr = view.state.tr.setMeta(activePluginKey, {
        editingId: newEditingId
      });

      view.dispatch(tr);
    });

    toolbar.appendChild(editButton);

    // Separator
    const separator = document.createElement('div');
    separator.className = 'code-block-toolbar-separator';
    toolbar.appendChild(separator);
  }

  // Copy button
  const copyButton = document.createElement('button');
  copyButton.className = 'code-block-toolbar-button';
  copyButton.setAttribute('aria-label', 'Copy');
  copyButton.innerHTML = `
    <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path>
    </svg>
  `;

  copyButton.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent selection loss
  });

  copyButton.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = node.textContent;
    copyToClipboard(text, { format: 'text/plain' });

    // Visual feedback
    const originalHTML = copyButton.innerHTML;
    copyButton.innerHTML = `
      <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M10.3801949,14.0826173 L7.75057979,11.0397723 C7.20059635,10.4033619 6.21972707,10.3173765 5.55974694,10.8477185 C4.89976681,11.3780605 4.81059688,12.3239001 5.36058032,12.9603105 L9.24943294,17.4602754 C9.89219597,18.2040451 11.0864488,18.1745362 11.6888655,17.3999992 L18.6888002,8.40006953 C19.2042612,7.73733301 19.0649733,6.79713833 18.377692,6.30008593 C17.6904108,5.80303354 16.7153955,5.93734707 16.1999346,6.60008359 L10.3801949,14.0826173 Z"></path>
      </svg>
    `;
    setTimeout(() => {
      copyButton.innerHTML = originalHTML;
    }, 2000);
  });

  toolbar.appendChild(copyButton);

  // Delete button
  const deleteButton = document.createElement('button');
  deleteButton.className = 'code-block-toolbar-button code-block-delete-button';
  deleteButton.setAttribute('aria-label', 'Delete block');
  deleteButton.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  `;

  deleteButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  deleteButton.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!view) return;
    const tr = view.state.tr.delete(codeBlockPos, codeBlockPos + node.nodeSize);
    view.dispatch(tr);
    view.focus();
  });

  toolbar.appendChild(deleteButton);

  // Separator
  const separator = document.createElement('div');
  separator.className = 'code-block-toolbar-separator';
  toolbar.appendChild(separator);

  // Language button
  const language = node.attrs.language || '';
  const langInfo = codeLanguages[language as keyof typeof codeLanguages];
  const label = langInfo?.label || 'Plain text';

  const languageButton = document.createElement('button');
  languageButton.className = 'code-block-toolbar-button code-block-language-button';
  languageButton.innerHTML = `
    <span class="code-block-language-label">${label}</span>
    <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.23823905,10.6097108 L11.207376,14.4695888 C11.54411,14.907343 12.1719566,14.989236 12.6097108,14.652502 C12.6783439,14.5997073 12.7398293,14.538222 12.792624,14.4695888 L15.761761,10.6097108 C16.0984949,10.1719566 16.0166019,9.54410997 15.5788477,9.20737601 C15.4040391,9.07290785 15.1896811,9 15.969137,9 L9.03086304,9 C8.47857829,9 8.03086304,9.44771525 8.03086304,10 C8.03086304,10.2205442 8.10377089,10.4349022 8.23823905,10.6097108 Z"></path>
    </svg>
  `;

  languageButton.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent selection loss
  });

  languageButton.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view) {
      openLanguageDropdown(languageButton, toolbar, node, codeBlockPos, view);
    }
  });

  toolbar.appendChild(languageButton);

  // Return widget decoration
  return Decoration.widget(pos, toolbar, {
    side: -1,
    stopEvent: () => true,
  });
}

/**
 * Create toolbar decoration for Mermaid diagram
 */
export function createMermaidContainerDecoration(
  node: ProsemirrorNode,
  pos: number,
  view: EditorView | null,
  diagram: DiagramToolbarConfig,
): Decoration {
  const toolbar = createMermaidToolbarElement(node, pos, view, diagram);
  toolbar.className = 'code-block-toolbar mermaid-toolbar';

  /** Find the diagram wrapper for this toolbar */
  const findDiagram = (): HTMLElement | null => {
    if (diagram.diagramId) {
      const wrapperIdPrefix = getDiagramWrapperIdPrefix(diagram.kind);
      const el = document.getElementById(`${wrapperIdPrefix}${diagram.diagramId}`);
      if (el) return el;
    }

    // Fallback: search siblings for a mermaid diagram wrapper
    if (toolbar.previousElementSibling) {
      const prev = toolbar.previousElementSibling;
      if (prev.classList.contains('mermaid-diagram-wrapper')) {
        return prev as HTMLElement;
      }
    }

    // Broader fallback: walk backwards from toolbar through siblings
    let el = toolbar.previousElementSibling;
    while (el) {
      if (el.classList.contains('mermaid-diagram-wrapper')) return el as HTMLElement;
      el = el.previousElementSibling;
    }
    return null;
  };

  // Function to position toolbar over diagram
  const positionToolbar = () => {
    const diagram = findDiagram();
    if (!diagram) return false;

    // Cache resolved diagramId on toolbar for edit button click handler
    if (diagram.id && toolbar.dataset.diagramId === 'unknown') {
      const wrapperIdPrefix = getDiagramWrapperIdPrefix(diagram.kind);
      toolbar.dataset.diagramId = diagram.id.replace(wrapperIdPrefix, '');
    }

    const diagramHeight = diagram.offsetHeight;
    const toolbarHeight = toolbar.offsetHeight;

    // Pull toolbar up to overlay top of diagram
    toolbar.style.marginTop = `${-(diagramHeight + toolbarHeight) + 16}px`;

    // Align toolbar with right edge of diagram (not container)
    const parent = diagram.offsetParent as HTMLElement;
    if (parent) {
      const parentWidth = parent.offsetWidth;
      const diagramRight = diagram.offsetLeft + diagram.offsetWidth;
      const marginRight = parentWidth - diagramRight;
      toolbar.style.marginRight = `${marginRight + 8}px`;
    }

    // Hover listeners: show toolbar when hovering diagram or toolbar.
    // The toolbar element is recreated on decoration rebuilds, so we store
    // the current reference on the diagram and use it in the listeners.
    (diagram as any)._mermaidToolbar = toolbar;

    if (!diagram.dataset.hoverBound) {
      diagram.dataset.hoverBound = 'true';
      diagram.addEventListener('mouseenter', () => {
        const tb = (diagram as any)._mermaidToolbar as HTMLElement | null;
        if (tb) tb.classList.add('diagram-hover');
      });
      diagram.addEventListener('mouseleave', () => {
        setTimeout(() => {
          const tb = (diagram as any)._mermaidToolbar as HTMLElement | null;
          if (tb && !tb.matches(':hover') && !diagram.matches(':hover')) {
            tb.classList.remove('diagram-hover');
          }
        }, 150);
      });
    }

    // Each new toolbar gets its own mouseleave handler
    toolbar.addEventListener('mouseleave', () => {
      setTimeout(() => {
        if (!toolbar.matches(':hover') && !diagram.matches(':hover')) {
          toolbar.classList.remove('diagram-hover');
        }
      }, 150);
    });

    return true;
  };

  // Position toolbar with retries — diagram may render asynchronously
  let retries = 0;
  const tryPosition = () => {
    if (positionToolbar()) return;
    if (retries++ < 10) {
      setTimeout(tryPosition, 200);
    }
  };
  requestAnimationFrame(tryPosition);

  // Reposition on window resize
  window.addEventListener('resize', positionToolbar);

  // Widget placed AFTER code block (after diagram widget)
  return Decoration.widget(pos + node.nodeSize, toolbar, {
    side: 10,
    stopEvent: () => true,
  });
}

/**
 * Create toolbar for Mermaid diagram (returns DOM element)
 */
function createMermaidToolbarElement(
  node: ProsemirrorNode,
  pos: number,
  view: EditorView | null,
  diagram: DiagramToolbarConfig,
): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'code-block-toolbar';
  toolbar.contentEditable = 'false';
  toolbar.dataset.diagramId = diagram.diagramId || 'unknown';

  // Edit button
  const editButton = document.createElement('button');
  editButton.className = 'code-block-toolbar-button';
  syncDiagramToggleButton(editButton, diagram.isEditing);

  editButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  editButton.addEventListener('click', (e) => {
    e.stopPropagation();

    if (!view) return;

    let diagramId = toolbar.dataset.diagramId;
    const wrapperClass = getDiagramWrapperClass(diagram.kind);
    const wrapperIdPrefix = getDiagramWrapperIdPrefix(diagram.kind);

    // Walk backwards through siblings to find diagram wrapper
    // (drag handle widget may sit between toolbar and diagram)
    if (diagramId === 'unknown') {
      let el = toolbar.previousElementSibling;
      while (el) {
        if (el.classList.contains(wrapperClass) && el.id) {
          diagramId = el.id.replace(wrapperIdPrefix, '');
          toolbar.dataset.diagramId = diagramId;
          break;
        }
        el = el.previousElementSibling;
      }
    }

    if (!diagramId || diagramId === 'unknown') return;

    const activePluginKey = getDiagramPluginKey(diagram.kind);
    const currentState = activePluginKey.getState(view.state);
    const isCurrentlyEditing = currentState?.editingId === diagramId;

    // Toggle editing mode
    const newEditingId = isCurrentlyEditing ? undefined : diagramId;
    syncDiagramToggleButton(editButton, !isCurrentlyEditing);
    const tr = view.state.tr.setMeta(activePluginKey, {
      editingId: newEditingId
    });

    view.dispatch(tr);
  });

  toolbar.appendChild(editButton);

  // Separator
  const separator = document.createElement('div');
  separator.className = 'code-block-toolbar-separator';
  toolbar.appendChild(separator);

  // Copy button
  const copyButton = document.createElement('button');
  copyButton.className = 'code-block-toolbar-button';
  copyButton.setAttribute('aria-label', 'Copy');
  copyButton.innerHTML = `
    <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path>
    </svg>
  `;

  copyButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  copyButton.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = node.textContent;
    copyToClipboard(text, { format: 'text/plain' });

    // Visual feedback
    const originalHTML = copyButton.innerHTML;
    copyButton.innerHTML = `
      <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M10.3801949,14.0826173 L7.75057979,11.0397723 C7.20059635,10.4033619 6.21972707,10.3173765 5.55974694,10.8477185 C4.89976681,11.3780605 4.81059688,12.3239001 5.36058032,12.9603105 L9.24943294,17.4602754 C9.89219597,18.2040451 11.0864488,18.1745362 11.6888655,17.3999992 L18.6888002,8.40006953 C19.2042612,7.73733301 19.0649733,6.79713833 18.377692,6.30008593 C17.6904108,5.80303354 16.7153955,5.93734707 16.1999346,6.60008359 L10.3801949,14.0826173 Z"></path>
      </svg>
    `;
    setTimeout(() => {
      copyButton.innerHTML = originalHTML;
    }, 2000);
  });

  toolbar.appendChild(copyButton);

  // Delete button
  const deleteButton = document.createElement('button');
  deleteButton.className = 'code-block-toolbar-button code-block-delete-button';
  deleteButton.setAttribute('aria-label', 'Delete block');
  deleteButton.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  `;

  deleteButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  deleteButton.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!view) return;
    const tr = view.state.tr.delete(pos, pos + node.nodeSize);
    view.dispatch(tr);
    view.focus();
  });

  toolbar.appendChild(deleteButton);

  return toolbar;
}
