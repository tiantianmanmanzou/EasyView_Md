/**
 * FrontmatterView — custom NodeView for YAML frontmatter
 *
 * Renders frontmatter as a styled key-value table.
 * Double-click toggles raw YAML editing mode via textarea.
 * Changes sync to ProseMirror model via transactions (triggers save).
 */

import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import yaml from 'js-yaml';

export class FrontmatterView implements NodeView {
  dom: HTMLElement;
  private display: HTMLElement;
  private editorWrap: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private node: Node;
  private editing = false;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    // Root container
    this.dom = document.createElement('div');
    this.dom.className = 'frontmatter-view';

    // Display mode: key-value table
    this.display = document.createElement('div');
    this.display.className = 'frontmatter-display';
    this.dom.appendChild(this.display);

    // Edit mode: textarea for raw YAML
    this.editorWrap = document.createElement('div');
    this.editorWrap.className = 'frontmatter-editor';
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'frontmatter-textarea';
    this.textarea.spellcheck = false;
    this.editorWrap.appendChild(this.textarea);
    this.editorWrap.style.display = 'none';
    this.dom.appendChild(this.editorWrap);

    // Textarea input → sync to ProseMirror model
    this.textarea.addEventListener('input', () => {
      this.syncToModel();
      this.autoResize();
    });

    // Escape → exit edit mode
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.setEditing(false);
        this.view.focus();
      }
      // Tab → insert 2 spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        this.textarea.value = this.textarea.value.substring(0, start) + '  ' + this.textarea.value.substring(end);
        this.textarea.selectionStart = this.textarea.selectionEnd = start + 2;
        this.syncToModel();
      }
    });

    // Blur → exit edit mode when focus leaves textarea
    this.textarea.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.editing) {
          this.setEditing(false);
        }
      }, 100);
    });

    // Double-click → enter edit mode
    this.display.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setEditing(true);
    });

    this.renderDisplay();
  }

  /** Sync textarea content to ProseMirror model via transaction */
  private syncToModel() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const newText = this.textarea.value;
    const oldText = this.node.textContent;
    if (newText === oldText) return;
    const start = pos + 1;
    const end = start + oldText.length;
    try {
      const { tr } = this.view.state;
      if (newText) {
        tr.replaceWith(start, end, this.view.state.schema.text(newText));
      } else {
        tr.delete(start, end);
      }
      this.view.dispatch(tr);
    } catch { /* ignore position errors */ }
  }

  /** Auto-resize textarea to fit content */
  private autoResize() {
    this.textarea.style.height = 'auto';
    this.textarea.style.height = this.textarea.scrollHeight + 'px';
  }

  /** Stop all events inside textarea from reaching ProseMirror */
  stopEvent(event: Event): boolean {
    if (this.editing) {
      return true;
    }
    return false;
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.editing) {
      // Only update textarea if model diverges (e.g., external edit / undo)
      if (node.textContent !== this.textarea.value) {
        const cursorPos = this.textarea.selectionStart;
        this.textarea.value = node.textContent;
        this.textarea.selectionStart = this.textarea.selectionEnd = Math.min(cursorPos, node.textContent.length);
        this.autoResize();
      }
    } else {
      this.renderDisplay();
    }
    return true;
  }

  selectNode() {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode() {
    this.dom.classList.remove('ProseMirror-selectednode');
    if (this.editing) {
      this.setEditing(false);
    }
  }

  private setEditing(editing: boolean) {
    this.editing = editing;
    if (editing) {
      this.textarea.value = this.node.textContent;
      this.display.style.display = 'none';
      this.editorWrap.style.display = '';
      this.autoResize();
      this.textarea.focus();
    } else {
      this.display.style.display = '';
      this.editorWrap.style.display = 'none';
      this.renderDisplay();
    }
  }

  /** Ignore all DOM mutations — we manage everything ourselves */
  ignoreMutation(): boolean {
    return true;
  }

  private renderDisplay() {
    const text = this.node.textContent;
    this.display.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'frontmatter-header';

    const label = document.createElement('span');
    label.className = 'frontmatter-label';
    label.textContent = 'FRONTMATTER';

    const hint = document.createElement('span');
    hint.className = 'frontmatter-hint';
    hint.textContent = 'Double-click to edit · Esc to close';

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'frontmatter-delete-btn';
    deleteBtn.setAttribute('aria-label', 'Delete block');
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    deleteBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pos = this.getPos();
      if (pos !== undefined) {
        const currentNode = this.view.state.doc.nodeAt(pos);
        if (currentNode) {
          const tr = this.view.state.tr.delete(pos, pos + currentNode.nodeSize);
          this.view.dispatch(tr);
          this.view.focus();
        }
      }
    });

    header.appendChild(label);
    header.appendChild(hint);
    header.appendChild(deleteBtn);
    this.display.appendChild(header);

    // Parse YAML (try strict first, then fallback for non-standard syntax)
    let data: Record<string, any> = {};
    try {
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, any>;
      }
    } catch {
      // Fallback: simple key-value extraction for non-standard YAML
      data = parseFrontmatterLoose(text);
    }

    const keys = Object.keys(data);
    if (keys.length === 0) {
      // Show highlighted raw as last resort
      const raw = document.createElement('div');
      raw.className = 'frontmatter-raw';
      raw.innerHTML = text.trim() ? highlightYaml(text) : '<em class="frontmatter-empty">Empty frontmatter</em>';
      this.display.appendChild(raw);
      return;
    }

    // Key-value grid
    const grid = document.createElement('div');
    grid.className = 'frontmatter-grid';

    for (const key of keys) {
      const value = data[key];
      const row = document.createElement('div');
      row.className = 'frontmatter-row';

      const keyEl = document.createElement('div');
      keyEl.className = 'frontmatter-key';
      keyEl.textContent = key;

      const valEl = document.createElement('div');
      valEl.className = 'frontmatter-value';
      this.renderValue(valEl, value);

      row.appendChild(keyEl);
      row.appendChild(valEl);
      grid.appendChild(row);
    }

    this.display.appendChild(grid);
  }

  private renderValue(container: HTMLElement, value: any) {
    if (value === null || value === undefined) {
      const el = document.createElement('span');
      el.className = 'frontmatter-null';
      el.textContent = 'null';
      container.appendChild(el);
    } else if (typeof value === 'boolean') {
      const chip = document.createElement('span');
      chip.className = `frontmatter-bool frontmatter-bool-${value}`;
      chip.textContent = String(value);
      container.appendChild(chip);
    } else if (Array.isArray(value)) {
      const chips = document.createElement('div');
      chips.className = 'frontmatter-chips';
      for (const item of value) {
        const chip = document.createElement('span');
        chip.className = 'frontmatter-chip';
        chip.textContent = typeof item === 'object' ? JSON.stringify(item) : String(item);
        chips.appendChild(chip);
      }
      container.appendChild(chips);
    } else if (typeof value === 'object') {
      const code = document.createElement('code');
      code.className = 'frontmatter-nested';
      code.textContent = yaml.dump(value, { indent: 2, lineWidth: -1 }).trim();
      container.appendChild(code);
    } else {
      const text = String(value);
      if (text.includes('\n')) {
        const pre = document.createElement('span');
        pre.className = 'frontmatter-multiline';
        pre.textContent = text;
        container.appendChild(pre);
      } else {
        container.textContent = text;
      }
    }
  }
}

/**
 * Loose frontmatter parser for non-standard YAML (e.g. backslash continuations).
 * Extracts top-level key: value pairs, joins continuation lines,
 * and collects list items (- item) into arrays.
 * Handles blank lines between list items and indented key: value after lists.
 */
function parseFrontmatterLoose(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = text.split('\n');
  let currentKey = '';
  let currentValue = '';
  let collectingList: string[] | null = null;
  let fromIndentedKey = false; // true when key was started from indented position

  function flush() {
    if (!currentKey) return;
    if (collectingList !== null) {
      result[currentKey] = collectingList;
      collectingList = null;
    } else {
      // Clean up backslash continuations and trim
      const clean = currentValue
        .replace(/\\\s*\n\s*/g, ' ')  // join backslash-continued lines
        .replace(/\\$/gm, '')          // trailing backslashes
        .trim();
      result[currentKey] = clean;
    }
    currentKey = '';
    currentValue = '';
    fromIndentedKey = false;
  }

  function startKey(key: string, rawVal: string, indented = false) {
    flush();
    currentKey = key;
    fromIndentedKey = indented;
    const val = rawVal.replace(/\\$/, '').trim();
    if (val === '' || val === '|' || val === '>' || val === '|\\' || val === '>\\') {
      currentValue = '';
      collectingList = null;
    } else {
      currentValue = val;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Top-level key: value (no leading whitespace)
    const keyMatch = line.match(/^([\w][\w.-]*)\s*:\s*(.*)/);
    if (keyMatch) {
      startKey(keyMatch[1], keyMatch[2]);
      continue;
    }

    // List item under current key (allow zero or more leading whitespace)
    const listMatch = line.match(/^\s*-\s+(.*)/);
    if (listMatch && currentKey) {
      if (collectingList === null) collectingList = [];
      collectingList.push(listMatch[1].replace(/\\$/, '').trim());
      continue;
    }

    // Indented key: value after a list or after another indented key — treat as new top-level key
    // (handles "- Bash\" followed by "  version: 1.0.0\" where version is a separate key)
    if ((collectingList !== null || fromIndentedKey) && currentKey) {
      const indentedKeyMatch = line.match(/^\s+([\w][\w.-]*)\s*:\s*(.*)/);
      if (indentedKeyMatch) {
        startKey(indentedKeyMatch[1], indentedKeyMatch[2], true);
        continue;
      }
    }

    // Empty/comment line — skip but don't break list collection
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    // Continuation line (indented, backslash-continued, or unmatched non-empty text under current key)
    if (currentKey) {
      const trimmed = line.replace(/\\$/, '').trim();
      if (trimmed) {
        if (currentValue) currentValue += '\n';
        currentValue += trimmed;
      }
      continue;
    }
  }

  flush();
  return result;
}

/** Simple YAML syntax highlighting for raw/invalid display */
function highlightYaml(text: string): string {
  return text.split('\n').map(line => {
    // Comment
    if (/^\s*#/.test(line)) {
      return `<span class="hl-comment">${escapeHtml(line)}</span>`;
    }
    // Key: value
    const m = line.match(/^(\s*)([\w-]+)(\s*:\s*)(.*)/);
    if (m) {
      const [, indent, key, colon, val] = m;
      return `${escapeHtml(indent)}<span class="hl-key">${escapeHtml(key)}</span><span class="hl-colon">${escapeHtml(colon)}</span>${highlightValue(val)}`;
    }
    // List item
    const li = line.match(/^(\s*-\s+)(.*)/);
    if (li) {
      return `<span class="hl-bullet">${escapeHtml(li[1])}</span>${highlightValue(li[2])}`;
    }
    return escapeHtml(line);
  }).join('\n');
}

function highlightValue(val: string): string {
  if (!val) return '';
  // Quoted string
  if (/^["']/.test(val)) return `<span class="hl-string">${escapeHtml(val)}</span>`;
  // Boolean
  if (/^(true|false)$/i.test(val)) return `<span class="hl-bool">${escapeHtml(val)}</span>`;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(val)) return `<span class="hl-number">${escapeHtml(val)}</span>`;
  // Null
  if (/^(null|~)$/i.test(val)) return `<span class="hl-null">${escapeHtml(val)}</span>`;
  // Block scalar indicator
  if (/^[|>]/.test(val)) return `<span class="hl-scalar">${escapeHtml(val)}</span>`;
  return escapeHtml(val);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
