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
import { pluginKey as mermaidPluginKey } from '../mermaid/MermaidPlugin';
import { openLanguageDropdown } from './CodeBlockLanguageDropdown';

export function createLineNumbersDecorations(
  node: ProsemirrorNode,
  pos: number,
  isMermaid: boolean,
  mermaidState: any
): Decoration[] {
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

  // For Mermaid diagrams, find diagramId from decorations
  let diagramId: string | undefined;
  if (isMermaid && mermaidState) {
    const decorations = mermaidState.decorationSet.find(pos, pos + node.nodeSize);
    const nodeDecoration = decorations.find((d: any) => d.spec?.diagramId && d.from === pos);
    diagramId = nodeDecoration?.spec?.diagramId;
  }

  // Determine if code should be hidden (for Mermaid in preview mode)
  const isEditing = isMermaid && diagramId && mermaidState?.editingId === diagramId;
  const mermaidClass = isMermaid ? (isEditing ? 'mermaid-editing' : 'mermaid-preview') : '';

  // Add node decoration to set attributes on the code block wrapper
  // Note: Don't use 'class' as it will overwrite existing classes from toDOM
  return [
    Decoration.node(pos, pos + node.nodeSize, {
      'data-line-numbers': lineNumbers,
      'data-gutter-width': String(gutterWidth),
      'data-mermaid-mode': mermaidClass || undefined,
      style: `--line-number-gutter-width: ${gutterWidth}`,
    }),
  ];
}

export function createToolbarDecoration(
  node: ProsemirrorNode,
  pos: number,
  codeBlockPos: number,
  view: EditorView | null,
  isMermaid: boolean,
  mermaidState: any
): Decoration {
  const toolbar = document.createElement('div');
  toolbar.className = 'code-block-toolbar';
  toolbar.contentEditable = 'false';

  // For Mermaid diagrams, add Edit button (always, works in both modes)
  if (isMermaid && view) {
    // Find diagramId from decorations
    let diagramId: string | undefined;
    if (mermaidState) {
      const codeBlockPos = pos - 1; // toolbar is at pos+1, so code block is at pos-1
      const decorations = mermaidState.decorationSet.find(codeBlockPos, codeBlockPos + node.nodeSize);
      if (decorations) {
        for (const dec of decorations) {
          if (dec.spec && dec.spec.diagramId) {
            diagramId = dec.spec.diagramId;
            break;
          }
        }
      }
    }

    const editButton = document.createElement('button');
    editButton.className = 'code-block-toolbar-button';
    editButton.setAttribute('aria-label', 'Toggle Edit/Preview');
    editButton.innerHTML = `
      <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
      </svg>
    `;

    editButton.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    editButton.addEventListener('click', (e) => {
      e.stopPropagation();

      if (!view || !diagramId) return;

      // Check current state dynamically
      const currentState = mermaidPluginKey.getState(view.state);
      const isCurrentlyEditing = currentState?.editingId === diagramId;

      // Toggle editing mode
      const newEditingId = isCurrentlyEditing ? undefined : diagramId;
      const tr = view.state.tr.setMeta(mermaidPluginKey, {
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
  // For Mermaid: pos is after code block (pos + nodeSize), place after diagram
  // For normal code: pos is inside code block (pos + 1), place at start
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
  mermaidState: any
): Decoration {
  // Find diagramId from Mermaid decorations (same way as CodeBlockView)
  let diagramId: string | undefined;
  if (mermaidState && mermaidState.decorationSet) {
    const decorations = mermaidState.decorationSet.find(pos, pos + node.nodeSize);
    const nodeDecoration = decorations?.find((d: any) => d.spec.diagramId && d.from === pos);
    diagramId = nodeDecoration?.spec.diagramId;
  }
  // Create toolbar
  const toolbar = createMermaidToolbarElement(node, pos, view, mermaidState, diagramId || 'unknown');
  toolbar.className = 'code-block-toolbar mermaid-toolbar';

  /** Find the diagram wrapper for this toolbar */
  const findDiagram = (): HTMLElement | null => {
    // Try to find diagram by ID first
    if (diagramId && diagramId !== 'unknown') {
      const el = document.getElementById(`mermaid-diagram-wrapper-${diagramId}`);
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
      toolbar.dataset.diagramId = diagram.id.replace('mermaid-diagram-wrapper-', '');
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
  mermaidState: any,
  initialDiagramId: string
): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'code-block-toolbar';
  toolbar.contentEditable = 'false';
  toolbar.dataset.diagramId = initialDiagramId;

  const isEditing = mermaidState?.editingId === initialDiagramId;

  // Edit button
  const editButton = document.createElement('button');
  editButton.className = 'code-block-toolbar-button';
  editButton.setAttribute('aria-label', isEditing ? 'Preview' : 'Edit');
  editButton.innerHTML = `
    <svg fill="currentColor" width="18px" height="18px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
    </svg>
  `;

  editButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });

  editButton.addEventListener('click', (e) => {
    e.stopPropagation();

    if (!view) return;

    let diagramId = toolbar.dataset.diagramId;

    // Walk backwards through siblings to find diagram wrapper
    // (drag handle widget may sit between toolbar and diagram)
    if (diagramId === 'unknown') {
      let el = toolbar.previousElementSibling;
      while (el) {
        if (el.classList.contains('mermaid-diagram-wrapper') && el.id) {
          diagramId = el.id.replace('mermaid-diagram-wrapper-', '');
          toolbar.dataset.diagramId = diagramId;
          break;
        }
        el = el.previousElementSibling;
      }
    }

    if (!diagramId || diagramId === 'unknown') return;

    const currentState = mermaidPluginKey.getState(view.state);
    const isCurrentlyEditing = currentState?.editingId === diagramId;

    // Toggle editing mode
    const newEditingId = isCurrentlyEditing ? undefined : diagramId;
    const tr = view.state.tr.setMeta(mermaidPluginKey, {
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
