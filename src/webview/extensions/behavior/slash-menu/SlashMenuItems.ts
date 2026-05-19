/**
 * Default Slash Menu Items
 *
 * Contains all ~30 slash menu items and the replaceWith() helper.
 * Extracted from SlashMenu.ts.
 */

import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../../../editor/EditorSchema';
import { getHeadingAnchors } from '../../blocks/heading/AnchorPlugin';
import { scheduleAutoEditComment } from '../../blocks/html-block/HtmlBlockExtension';
import { showHeadingPicker } from './SlashMenuHeadingPicker';
import { showImageUrlPopup } from './SlashMenuImagePopup';
import type { SlashMenuItem } from './SlashMenu';

// ─── Helper: replace paragraph with node(s) ─────────────────────────────────

export function replaceWith(view: EditorView, from: number, to: number, node: any) {
  const tr = view.state.tr.replaceWith(from, to, node);
  // Position cursor at the start of the new node
  const newPos = from + 1;
  tr.setSelection(TextSelection.create(tr.doc, newPos));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// ─── Menu Items ─────────────────────────────────────────────────────────────

export const defaultSlashItems: SlashMenuItem[] = [
  // ── Headings ──
  {
    id: 'h1', label: 'Heading 1', group: 'heading',
    icon: '<span style="font-weight:700;font-size:14px">H1</span>',
    keywords: ['heading', 'h1', 'title', 'заголовок'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.heading.create({ level: 1 })),
  },
  {
    id: 'h2', label: 'Heading 2', group: 'heading',
    icon: '<span style="font-weight:700;font-size:13px">H2</span>',
    keywords: ['heading', 'h2', 'заголовок'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.heading.create({ level: 2 })),
  },
  {
    id: 'h3', label: 'Heading 3', group: 'heading',
    icon: '<span style="font-weight:600;font-size:12px">H3</span>',
    keywords: ['heading', 'h3', 'заголовок'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.heading.create({ level: 3 })),
  },
  // ── Lists ──
  {
    id: 'bullet-list', label: 'Bullet List', group: 'list',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>',
    keywords: ['list', 'bullet', 'unordered', 'список'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.bullet_list.create(null, [
        schema.nodes.list_item.create(null, schema.nodes.paragraph.create()),
      ])),
  },
  {
    id: 'ordered-list', label: 'Ordered List', group: 'list',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="3" y="7" font-size="8" fill="currentColor" stroke="none">1</text><text x="3" y="13" font-size="8" fill="currentColor" stroke="none">2</text><text x="3" y="19" font-size="8" fill="currentColor" stroke="none">3</text></svg>',
    keywords: ['list', 'ordered', 'numbered', 'нумерованный'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.ordered_list.create(null, [
        schema.nodes.list_item.create(null, schema.nodes.paragraph.create()),
      ])),
  },
  {
    id: 'checkbox', label: 'Checkbox List', group: 'list',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9.99992841,5.99992841 L19.0000716,5.99992841 L19.0000716,5.99992841 C19.5523168,5.99992841 20,6.4476116 20,6.99985681 L20,6.99985681 C20,7.55210202 19.5523168,7.99978522 19.0000716,7.99978522 L9.99992841,7.99978522 L9.99992841,7.99978522 C9.4476832,7.99978522 9,7.55210202 9,6.99985681 C9,6.4476116 9.4476832,5.99992841 9.99992841,5.99992841 L9.99992841,5.99992841 Z M9.99992841,15.9992125 L19.0000716,15.9992125 L19.0000716,15.9992125 C19.5523168,15.9992125 20,16.4468957 20,16.9991409 L20,16.9991409 L20,16.9991409 C20,17.5513861 19.5523168,17.9990693 19.0000716,17.9990693 L9.99992841,17.9990693 C9.4476832,17.9990693 9,17.5513861 9,16.9991409 C9,16.4468957 9.4476832,15.9992125 9.99992841,15.9992125 Z M9.99992841,10.9995704 L19.0000716,10.9995704 L19.0000716,10.9995704 C19.5523168,10.9995704 20,11.4472536 20,11.9994988 L20,11.9994988 C20,12.5517441 19.5523168,12.9994273 19.0000716,12.9994273 L9.99992841,12.9994273 C9.4476832,12.9994273 9,12.5517441 9,11.9994988 C9,11.4472536 9.4476832,10.9995704 9.99992841,10.9995704 Z M5.22935099,7.69420576 L7.09998441,5.20002786 C7.26566855,4.97911569 7.57906677,4.93434451 7.79997895,5.10002864 C8.02089112,5.26571278 8.0656623,5.579111 7.89997817,5.80002318 L5.64999574,8.79999974 C5.45636149,9.05817875 5.07249394,9.06801504 4.86589123,8.82009178 L3.61590099,7.3201035 C3.43912033,7.10796671 3.46778214,6.79268682 3.67991893,6.61590616 C3.89205572,6.4391255 4.20733561,6.46778731 4.38411627,6.6799241 L5.22935099,7.69420576 Z M5.22935099,12.6942058 L7.09998441,10.2000279 C7.26566855,9.97911569 7.57906677,9.93434451 7.79997895,10.1000286 C8.02089112,10.2657128 8.0656623,10.579111 7.89997817,10.8000232 L5.64999574,13.7999997 C5.45636149,14.0581787 5.07249394,14.068015 4.86589123,13.8200918 L3.61590099,12.3201035 C3.43912033,12.1079667 3.46778214,11.7926868 3.67991893,11.6159062 C3.89205572,11.4391255 4.20733561,11.4677873 4.38411627,11.6799241 L5.22935099,12.6942058 Z M5.22935099,17.6942058 L7.09998441,15.2000279 C7.26566855,14.9791157 7.57906677,14.9343445 7.79997895,15.1000286 C8.02089112,15.2657128 8.0656623,15.579111 7.89997817,15.8000232 L5.64999574,18.7999997 C5.45636149,19.0581787 5.07249394,19.068015 4.86589123,18.8200918 L3.61590099,17.3201035 C3.43912033,17.1079667 3.46778214,16.7926868 3.67991893,16.6159062 C3.89205572,16.4391255 4.20733561,16.4677873 4.38411627,16.6799241 L5.22935099,17.6942058 Z"></path></svg>',
    keywords: ['checkbox', 'todo', 'task', 'check', 'задача'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.checkbox_list.create(null, [
        schema.nodes.checkbox_item.create({ checked: false }, schema.nodes.paragraph.create()),
      ])),
  },
  {
    id: 'description-list', label: 'Description List', group: 'list',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    keywords: ['description', 'definition', 'term', 'glossary', 'dl', 'dt', 'dd', 'определение'],
    command: (view, from, to) => {
      const term = schema.nodes.description_term.create(null, schema.text('Term'));
      const detail = schema.nodes.description_detail.create(
        null, schema.nodes.paragraph.create(null, schema.text('Definition'))
      );
      const dl = schema.nodes.description_list.create(null, [term, detail]);
      replaceWith(view, from, to, dl);
    },
  },
  // ── Blocks ──
  {
    id: 'blockquote', label: 'Blockquote', group: 'block',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>',
    keywords: ['quote', 'blockquote', 'цитата'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.blockquote.create(null, schema.nodes.paragraph.create())),
  },
  {
    id: 'details', label: 'Collapsible Section', group: 'block',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    keywords: ['details', 'summary', 'collapse', 'collapsible', 'expand', 'toggle', 'fold', 'spoiler', 'свернуть', 'раскрыть', 'спойлер'],
    command: (view, from, to) => {
      const node = schema.nodes.details.create(
        { summary: 'Click to expand' },
        schema.nodes.paragraph.create()
      );
      const tr = view.state.tr.replaceWith(from, to, [node, schema.nodes.paragraph.create()]);
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  },
  {
    id: 'table', label: 'Table', group: 'block',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 5H18C19.1046 5 20 5.89543 20 7V17C20 18.1046 19.1046 19 18 19H6C4.89543 19 4 18.1046 4 17V7C4 5.89543 4.89543 5 6 5ZM6 11H11V13H6V11ZM18 11H13V13H18V11ZM6 15H11V17H6V15ZM18 15H13V17H18V15ZM6 7H11V9H6V7ZM18 7H13V9H18V7Z"></path></svg>',
    keywords: ['table', 'grid', 'таблица'],
    command: (view, from, to) => {
      const headerCells = [];
      const dataCells = [];
      for (let i = 0; i < 3; i++) {
        headerCells.push(schema.nodes.table_header.createAndFill()!);
        dataCells.push(schema.nodes.table_cell.createAndFill()!);
      }
      replaceWith(view, from, to, schema.nodes.table.create(null, [
        schema.nodes.table_row.create(null, headerCells),
        schema.nodes.table_row.create(null, dataCells),
      ]));
    },
  },
  {
    id: 'hr', label: 'Divider', group: 'block',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5,11 L19,11 C19.5522847,11 20,11.4477153 20,12 C20,12.5522847 19.5522847,13 19,13 L5,13 C4.44771525,13 4,12.5522847 4,12 C4,11.4477153 4.44771525,11 5,11 L5,11 Z M7,6 L17,6 C17.5522847,6 18,6.44771525 18,7 L18,8 C18,8.55228475 17.5522847,9 17,9 L7,9 C6.44771525,9 6,8.55228475 6,8 L6,7 L6,7 C6,6.44771525 6.44771525,6 7,6 Z M7,15 L17,15 C17.5522847,15 18,15.4477153 18,16 L18,17 C18,17.5522847 17.5522847,18 17,18 L7,18 C6.44771525,18 6,17.5522847 6,17 L6,16 C6,15.4477153 6.44771525,15 7,15 Z"></path></svg>',
    keywords: ['divider', 'horizontal', 'rule', 'separator', 'hr', 'разделитель'],
    command: (view, from, to) => {
      const tr = view.state.tr.replaceWith(from, to, [
        schema.nodes.horizontal_rule.create(),
        schema.nodes.paragraph.create(),
      ]);
      const newPos = from + 2;
      tr.setSelection(TextSelection.create(tr.doc, newPos));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  },
  {
    id: 'toc', label: 'Table of Contents', group: 'block',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    keywords: ['toc', 'contents', 'outline', 'navigation', 'оглавление', 'содержание'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.table_of_contents.create()),
  },
  {
    id: 'frontmatter', label: 'Frontmatter', group: 'block',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    keywords: ['frontmatter', 'yaml', 'meta', 'metadata', 'метаданные'],
    command: (view, from, to) => {
      // Frontmatter must be the first node in the document (schema: frontmatter? block+)
      const firstChild = view.state.doc.firstChild;
      if (firstChild?.type.name === 'frontmatter') return; // already exists

      let tr = view.state.tr;
      // Replace the "/" paragraph with an empty paragraph to keep block+ satisfied
      tr = tr.replaceWith(from, to, schema.nodes.paragraph.create());
      // Insert frontmatter at the beginning of the document
      const fmNode = schema.nodes.frontmatter.create(null, schema.text('title: '));
      tr = tr.insert(0, fmNode);
      tr.setSelection(NodeSelection.create(tr.doc, 0));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  },
  // ── Code & Math ──
  {
    id: 'code-block', label: 'Code Block', group: 'code',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    keywords: ['code', 'pre', 'block', 'fence', 'код'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.code_block.create({ language: '' })),
  },
  {
    id: 'mermaid', label: 'Mermaid Diagram', group: 'code',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="8" y="14" width="8" height="7" rx="1"/><line x1="6.5" y1="10" x2="6.5" y2="14"/><line x1="17.5" y1="10" x2="17.5" y2="14"/><line x1="6.5" y1="14" x2="12" y2="14"/><line x1="17.5" y1="14" x2="12" y2="14"/></svg>',
    keywords: ['mermaid', 'diagram', 'flowchart', 'sequence', 'graph', 'диаграмма'],
    command: (view, from, to) => {
      const node = schema.nodes.code_block.create(
        { language: 'mermaid' },
        schema.text('graph TD\n    A[Start] --> B[End]')
      );
      replaceWith(view, from, to, node);
    },
  },
  {
    id: 'math-inline', label: 'Math (inline)', group: 'code',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    keywords: ['math', 'formula', 'equation', 'latex', 'katex', 'inline', 'формула'],
    command: (view, from, to) => {
      const node = schema.nodes.math_inline.create(undefined, schema.text('E = mc^2'));
      replaceWith(view, from, to, schema.nodes.paragraph.create(null, node));
    },
  },
  {
    id: 'math-block', label: 'Math Block', group: 'code',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 8l3 4-3 4"/><path d="M14 8h3"/><path d="M14 16h3"/></svg>',
    keywords: ['math', 'formula', 'equation', 'latex', 'katex', 'block', 'display', 'формула'],
    command: (view, from, to) => {
      const node = schema.nodes.math_block.create(
        undefined, schema.text('\\int_0^\\infty e^{-x} dx = 1')
      );
      replaceWith(view, from, to, node);
    },
  },
  // ── Callouts ──
  {
    id: 'notice-note', label: 'Note', group: 'callout',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#5B9DD9"><path fill-rule="evenodd" d="M20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12ZM11 8C11 8.55228 11.4477 9 12 9C12.5523 9 13 8.55228 13 8C13 7.44772 12.5523 7 12 7C11.4477 7 11 7.44772 11 8ZM12 10C13 10 13 11 13 11V16C13 16 13 17 12 17C11 17 11 16 11 16V11C11 11 11 11 10.5 11C10 11 10 10 10 10H12Z"></path></svg>',
    keywords: ['notice', 'note', 'callout', 'info', 'заметка'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.notice.create({ style: 'note' }, schema.nodes.paragraph.create())),
  },
  {
    id: 'notice-tip', label: 'Tip', group: 'callout',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#66BB6A"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM9.26825 11.3599L10.9587 13.3885L14.7 8.40006C15.0314 7.95823 15.6582 7.86869 16.1 8.20006C16.5419 8.53143 16.6314 9.15823 16.3 9.60006L11.8 15.6001C11.4128 16.1164 10.645 16.1361 10.2318 15.6402L7.7318 12.6402C7.37824 12.216 7.43556 11.5854 7.85984 11.2318C8.28412 10.8783 8.91468 10.9356 9.26825 11.3599Z"></path></svg>',
    keywords: ['notice', 'tip', 'hint', 'совет'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.notice.create({ style: 'tip' }, schema.nodes.paragraph.create())),
  },
  {
    id: 'notice-important', label: 'Important', group: 'callout',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#9575CD"><path d="M12,16.1500001 L8.79729751,17.8337604 L8.79729751,17.8337604 C8.30845292,18.0907612 7.70382577,17.9028147 7.44682496,17.4139701 C7.34448589,17.2193097 7.30917121,16.9963416 7.34634806,16.779584 L7.95800981,13.2133223 L5.36696906,10.6876818 L5.36696906,10.6876818 C4.97148548,10.3021806 4.96339318,9.66906733 5.34889439,9.27358375 C5.50240299,9.11610012 5.70354541,9.01361294 5.92118244,8.98198843 L9.50191268,8.46167787 L11.1032639,5.21698585 L11.1032639,5.21698585 C11.3476862,4.72173219 11.9473121,4.51839319 12.4425657,4.76281548 C12.6397783,4.86014572 12.7994058,5.01977324 12.8967361,5.21698585 L14.4980873,8.46167787 L18.0788176,8.98198843 L18.0788176,8.98198843 C18.6253624,9.06140605 19.0040439,9.5688489 18.9246263,10.1153938 C18.8930018,10.3330308 18.7905146,10.5341732 18.6330309,10.6876818 L16.0419902,13.2133223 L16.6536519,16.779584 L16.6536519,16.779584 C16.747013,17.3239204 16.3814251,17.8408763 15.8370887,17.9342373 C15.620331,17.9714142 15.397363,17.9360995 15.2027025,17.8337604 L12,16.1500001 Z"></path></svg>',
    keywords: ['notice', 'important', 'crucial', 'важно'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.notice.create({ style: 'important' }, schema.nodes.paragraph.create())),
  },
  {
    id: 'notice-caution', label: 'Caution', group: 'callout',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#E8A435"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20ZM12 15C12.5523 15 13 15.4477 13 16C13 16.5523 12.5523 17 12 17C11.4477 17 11 16.5523 11 16C11 15.4477 11.4477 15 12 15ZM12 14C13 14 13 13 13 13L13 10.5L13 8C13 8 13 7 12 7C11 7 11 8 11 8L11 13C11 13 11 14 12 14Z"></path></svg>',
    keywords: ['notice', 'caution', 'danger', 'осторожно'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.notice.create({ style: 'caution' }, schema.nodes.paragraph.create())),
  },
  {
    id: 'notice-warning', label: 'Warning', group: 'callout',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="#E57373"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20ZM9.29289 9.29289C9.68342 8.90237 10.3166 8.90237 10.7071 9.29289L12 10.5858L13.2929 9.29289C13.6834 8.90237 14.3166 8.90237 14.7071 9.29289C15.0976 9.68342 15.0976 10.3166 14.7071 10.7071L13.4142 12L14.7071 13.2929C15.0976 13.6834 15.0976 14.3166 14.7071 14.7071C14.3166 15.0976 13.6834 15.0976 13.2929 14.7071L12 13.4142L10.7071 14.7071C10.3166 15.0976 9.68342 15.0976 9.29289 14.7071C8.90237 14.3166 8.90237 13.6834 9.29289 13.2929L10.5858 12L9.29289 10.7071C8.90237 10.3166 8.90237 9.68342 9.29289 9.29289Z"></path></svg>',
    keywords: ['notice', 'warning', 'предупреждение'],
    command: (view, from, to) => replaceWith(view, from, to,
      schema.nodes.notice.create({ style: 'warning' }, schema.nodes.paragraph.create())),
  },
  // ── Insert ──
  {
    id: 'image', label: 'Image', group: 'insert',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    keywords: ['image', 'picture', 'photo', 'img', 'изображение', 'картинка'],
    command: (view, from, to) => {
      showImageUrlPopup(view, from, to);
    },
  },
  {
    id: 'image-file', label: 'Image from file', group: 'insert',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    keywords: ['image', 'file', 'browse', 'upload', 'загрузить', 'файл', 'картинка'],
    command: (view, from, to) => {
      const tr = view.state.tr.delete(from, to);
      view.dispatch(tr);
      view.focus();
      window.dispatchEvent(new CustomEvent('inlinemd:pickImage', { detail: { pos: -1 } }));
    },
  },
  {
    id: 'anchor-link', label: 'Link to heading', group: 'insert',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    keywords: ['anchor', 'link', 'heading', 'internal', 'якорь', 'ссылка', 'заголовок'],
    command: (view, from, to) => {
      const anchors = getHeadingAnchors(view.state.doc);
      if (anchors.length === 0) return;
      showHeadingPicker(view, from, to, anchors);
    },
  },
  {
    id: 'comment', label: 'Comment', group: 'insert',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    keywords: ['comment', 'hidden', 'html', 'note', 'комментарий'],
    command: (view, from, to) => {
      const commentNode = schema.nodes.html_block.create({ html: '<!-- Comment -->' });
      const tr = view.state.tr.replaceWith(from, to, [
        commentNode,
        schema.nodes.paragraph.create(),
      ]);
      // Select the comment node so NodeView auto-enters edit mode
      tr.setSelection(NodeSelection.create(tr.doc, from));
      scheduleAutoEditComment();
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  },
  {
    id: 'html-block', label: 'HTML Block', group: 'insert',
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    keywords: ['html', 'block', 'raw', 'code', 'embed'],
    command: (view, from, to) => {
      const htmlNode = schema.nodes.html_block.create({ html: '<div>\n  \n</div>' });
      const tr = view.state.tr.replaceWith(from, to, [
        htmlNode,
        schema.nodes.paragraph.create(),
      ]);
      tr.setSelection(NodeSelection.create(tr.doc, from));
      view.dispatch(tr.scrollIntoView());
      view.focus();
    },
  },
];
