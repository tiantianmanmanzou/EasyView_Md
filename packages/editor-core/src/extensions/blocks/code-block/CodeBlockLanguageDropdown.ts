/**
 * Code Block Language Dropdown
 *
 * Handles the language selection dropdown UI for code blocks,
 * including keyboard search, outside click handling, and language change.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { codeLanguages } from '../../../editor/lib/CodeLanguages';

let activeDropdown: HTMLElement | null = null;
let activeToolbar: HTMLElement | null = null;
let activeButton: HTMLElement | null = null;
let searchBuffer = '';
let searchTimeout: any = null;

export function openLanguageDropdown(
  button: HTMLElement,
  toolbar: HTMLElement,
  node: ProsemirrorNode,
  pos: number,
  view: EditorView
) {
  // If clicking the same button, just close the dropdown (toggle)
  if (activeDropdown && activeButton === button) {
    closeLanguageDropdown();
    return;
  }

  // Close existing dropdown if any
  if (activeDropdown) {
    closeLanguageDropdown();
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'code-block-language-dropdown';
  dropdown.tabIndex = 0; // Make focusable for keyboard events

  const currentLang = node.attrs.language || '';

  // Create menu items (skip duplicates like mermaidjs)
  Object.entries(codeLanguages).forEach(([key, lang]) => {
    // Skip mermaidjs - it's a duplicate of mermaid
    if (key === 'mermaidjs') return;

    const item = document.createElement('button');
    item.className = 'code-block-language-item';
    item.textContent = lang.label;
    item.dataset.lang = key;

    // Add checkmark if current language (handle mermaidjs -> mermaid alias)
    const isCurrentLang = key === currentLang ||
                          (key === 'mermaid' && currentLang === 'mermaidjs') ||
                          (key === 'none' && !currentLang);
    if (isCurrentLang) {
      const checkmark = document.createElement('svg');
      checkmark.setAttribute('fill', 'currentColor');
      checkmark.setAttribute('width', '18px');
      checkmark.setAttribute('height', '18px');
      checkmark.setAttribute('viewBox', '0 0 24 24');
      checkmark.innerHTML = `<path d="M10.3801949,14.0826173 L7.75057979,11.0397723 C7.20059635,10.4033619 6.21972707,10.3173765 5.55974694,10.8477185 C4.89976681,11.3780605 4.81059688,12.3239001 5.36058032,12.9603105 L9.24943294,17.4602754 C9.89219597,18.2040451 11.0864488,18.1745362 11.6888655,17.3999992 L18.6888002,8.40006953 C19.2042612,7.73733301 19.0649733,6.79713833 18.377692,6.30008593 C17.6904108,5.80303354 16.7153955,5.93734707 16.1999346,6.60008359 L10.3801949,14.0826173 Z"></path>`;
      item.appendChild(checkmark);
      item.classList.add('selected');
    }

    item.addEventListener('click', () => {
      changeLanguage(lang.lang, pos, node, view);
      closeLanguageDropdown();
    });

    dropdown.appendChild(item);
  });

  // Position dropdown below the button
  const buttonRect = button.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top = `${buttonRect.bottom + 4}px`;
  dropdown.style.left = `${buttonRect.left}px`;
  dropdown.style.minWidth = `${buttonRect.width}px`;

  document.body.appendChild(dropdown);
  activeDropdown = dropdown;
  activeToolbar = toolbar;
  activeButton = button;

  // Add class to toolbar to keep it visible
  toolbar.classList.add('has-dropdown');

  // Focus dropdown for keyboard events
  setTimeout(() => {
    dropdown.focus();
  }, 0);

  // Keyboard search
  dropdown.addEventListener('keydown', handleDropdownKeydown);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 0);
}

function handleDropdownKeydown(e: KeyboardEvent) {
  if (!activeDropdown) return;

  // Handle letter keys for search
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) {
    e.preventDefault();

    // Add to search buffer
    searchBuffer += e.key.toLowerCase();

    // Clear previous timeout
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    // Reset buffer after 1 second
    searchTimeout = setTimeout(() => {
      searchBuffer = '';
    }, 1000);

    // Find matching item
    const items = Array.from(activeDropdown.querySelectorAll('.code-block-language-item'));
    const matchingItem = items.find(item => {
      const text = item.textContent?.toLowerCase() || '';
      return text.startsWith(searchBuffer);
    });

    if (matchingItem) {
      matchingItem.scrollIntoView({ block: 'start', behavior: 'smooth' });
      // Highlight matching item
      items.forEach(item => item.classList.remove('highlighted'));
      matchingItem.classList.add('highlighted');
    }
  }

  // Handle Escape to close
  if (e.code === 'Escape') {
    e.preventDefault();
    closeLanguageDropdown();
  }
}

function closeLanguageDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
    document.removeEventListener('click', handleOutsideClick);
  }

  // Remove class from toolbar
  if (activeToolbar) {
    activeToolbar.classList.remove('has-dropdown');
    activeToolbar = null;
  }

  // Clear active button
  activeButton = null;

  // Clear search buffer
  searchBuffer = '';
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
}

function handleOutsideClick(e: MouseEvent) {
  if (activeDropdown && !activeDropdown.contains(e.target as Node)) {
    closeLanguageDropdown();
  }
}

function changeLanguage(
  language: string,
  pos: number,
  node: ProsemirrorNode,
  view: EditorView
) {
  const tr = view.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    language
  });
  view.dispatch(tr);
}
