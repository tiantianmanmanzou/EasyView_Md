/**
 * HtmlTagDropdown — dropdown for toggling inline HTML tags (kbd, sub, sup, etc.)
 */

import { EditorView } from 'prosemirror-view';
import { isHtmlTagActive, toggleHtmlTag } from '../../../editor/EditorCommands';

// ─── Types ───────────────────────────────────────────────────────────────────

interface HtmlTagDef {
  tag: string;
  title: string;
  icon: string;
}

// ─── Tag Definitions ─────────────────────────────────────────────────────────

const htmlTags: HtmlTagDef[] = [
  {
    tag: 'kbd',
    title: 'Keyboard Key',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h2M11 10h2M15 10h2M8 14h8"/></svg>',
  },
  {
    tag: 'sub',
    title: 'Subscript',
    icon: '<span style="font-size:13px">X<span style="font-size:9px;vertical-align:sub">2</span></span>',
  },
  {
    tag: 'sup',
    title: 'Superscript',
    icon: '<span style="font-size:13px">X<span style="font-size:9px;vertical-align:super">2</span></span>',
  },
  {
    tag: 'var',
    title: 'Variable',
    icon: '<span style="font-size:14px;font-style:italic;font-family:Georgia,Times,serif">x</span>',
  },
  {
    tag: 'small',
    title: 'Small Text',
    icon: '<span style="font-size:14px;line-height:1">A<span style="font-size:9px">a</span></span>',
  },
  {
    tag: 'samp',
    title: 'Sample Output',
    icon: '<span style="font-size:11px;font-family:var(--vscode-editor-font-family,monospace)">$_</span>',
  },
];

// ─── HtmlTagDropdown ─────────────────────────────────────────────────────────

export class HtmlTagDropdown {
  private el: HTMLDivElement;
  private view: EditorView | null = null;
  private isVisible = false;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'html-tag-dropdown';

    for (const def of htmlTags) {
      const btn = document.createElement('button');
      btn.className = 'html-tag-btn';
      btn.innerHTML = def.icon;
      btn.title = `${def.title} <${def.tag}>`;
      btn.dataset.tag = def.tag;
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.view) {
          toggleHtmlTag(def.tag)(this.view.state, this.view.dispatch);
          this.view.focus();
          this.updateActiveStates();
        }
      });
      this.el.appendChild(btn);
    }

    document.body.appendChild(this.el);
  }

  toggle(view: EditorView) {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show(view);
    }
  }

  show(view: EditorView) {
    this.view = view;
    this.el.classList.add('visible');
    this.isVisible = true;
    this.updateActiveStates();
    requestAnimationFrame(() => this.updatePosition());

    if (!this.outsideClickHandler) {
      this.outsideClickHandler = (e: MouseEvent) => {
        if (!this.el.contains(e.target as Node) &&
            !(e.target as HTMLElement).closest('[data-command="html-tags"]')) {
          this.hide();
        }
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this.outsideClickHandler!);
      }, 0);
    }
  }

  hide() {
    if (!this.isVisible) return;
    this.el.classList.remove('visible');
    this.isVisible = false;

    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
  }

  get visible() { return this.isVisible; }

  private updateActiveStates() {
    if (!this.view) return;
    const state = this.view.state;
    const btns = this.el.querySelectorAll('.html-tag-btn');
    btns.forEach((btn) => {
      const tag = (btn as HTMLElement).dataset.tag!;
      if (isHtmlTagActive(state, tag)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  private updatePosition() {
    const htmlBtn = document.querySelector('.floating-toolbar .toolbar-button[data-command="html-tags"]');
    if (!htmlBtn) return;
    const rect = htmlBtn.getBoundingClientRect();
    const dropdownWidth = this.el.offsetWidth;

    let left = rect.left + rect.width / 2 - dropdownWidth / 2;
    const top = rect.bottom + 4;

    left = Math.max(8, Math.min(left, window.innerWidth - dropdownWidth - 8));

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  destroy() {
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
    }
    this.el.remove();
  }
}

export const htmlTagDropdown = new HtmlTagDropdown();
