/**
 * ExtensionManager — collects contributions from all extensions
 * and builds the ProseMirror schema, plugins, parser, and serializer.
 */

import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { keymap } from 'prosemirror-keymap';
import { inputRules } from 'prosemirror-inputrules';
import { MarkdownParser } from 'prosemirror-markdown';
import { MarkdownSerializer } from 'prosemirror-markdown';
import type { NodeViewConstructor, EditorView } from 'prosemirror-view';
import type MarkdownIt from 'markdown-it';

import { Extension, type SlashMenuItem, type ToolbarButton } from './EditorExtension';

// ─── Base schema nodes (always present) ─────────────────────────────────────

const BASE_NODES: Record<string, NodeSpec> = {
  doc: {
    content: 'frontmatter? block+',
  },
  text: {
    group: 'inline',
  },
  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return ['p', 0];
    },
  },
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM() {
      return ['br'];
    },
  },
};

// ─── ExtensionManager ───────────────────────────────────────────────────────

export class ExtensionManager {
  private extensions: Extension[];
  private _schema: Schema | null = null;

  constructor(extensions: Extension[]) {
    this.extensions = extensions;
  }

  /** Get all registered extensions */
  getExtensions(): readonly Extension[] {
    return this.extensions;
  }

  /** Get extension by name */
  getExtension(name: string): Extension | undefined {
    return this.extensions.find((ext) => ext.name === name);
  }

  // ── Schema ──

  /**
   * Build the ProseMirror Schema from all extensions' node and mark specs.
   * Base nodes (doc, text, paragraph, hard_break) are always included.
   */
  buildSchema(): Schema {
    if (this._schema) return this._schema;

    const nodes: Record<string, NodeSpec> = { ...BASE_NODES };
    const marks: Record<string, MarkSpec> = {};

    for (const ext of this.extensions) {
      const extNodes = ext.nodes;
      for (const [name, spec] of Object.entries(extNodes)) {
        if (nodes[name]) {
          console.warn(`[ExtensionManager] Duplicate node "${name}" from extension "${ext.name}", overwriting.`);
        }
        nodes[name] = spec;
      }

      const extMarks = ext.marks;
      for (const [name, spec] of Object.entries(extMarks)) {
        if (marks[name]) {
          console.warn(`[ExtensionManager] Duplicate mark "${name}" from extension "${ext.name}", overwriting.`);
        }
        marks[name] = spec;
      }
    }

    this._schema = new Schema({ nodes, marks });
    return this._schema;
  }

  // ── Plugins ──

  /**
   * Collect all plugins from extensions.
   *
   * For each extension (in order): keymaps → plugins.
   * This preserves per-extension priority — e.g. ListsExtension's
   * list-specific keymap plugins come before SmartTextExtension's
   * base keymap plugin.
   *
   * Input rules from all extensions are merged into a single plugin at the end.
   */
  buildPlugins(schema: Schema): Plugin[] {
    const allInputRules: any[] = [];
    const result: Plugin[] = [];

    for (const ext of this.extensions) {
      // Keymaps for this extension (wrapped in keymap plugin)
      const extKeymaps = ext.keymaps(schema);
      if (Object.keys(extKeymaps).length > 0) {
        result.push(keymap(extKeymaps));
      }

      // Plugins for this extension (may include additional keymap plugins)
      const extPlugins = ext.plugins(schema);
      result.push(...extPlugins);

      // Collect input rules (merged into one plugin at the end)
      const extRules = ext.inputRules(schema);
      allInputRules.push(...extRules);
    }

    if (allInputRules.length > 0) {
      result.push(inputRules({ rules: allInputRules }));
    }

    return result;
  }

  // ── NodeViews ──

  /**
   * Collect all NodeView constructors from extensions.
   */
  buildNodeViews(): Record<string, NodeViewConstructor> {
    const nodeViews: Record<string, NodeViewConstructor> = {};

    for (const ext of this.extensions) {
      const extNodeViews = ext.nodeViews;
      Object.assign(nodeViews, extNodeViews);
    }

    return nodeViews;
  }

  // ── Parser ──

  /**
   * Configure a markdown-it instance with all extensions' rules.
   */
  configureMarkdownIt(md: MarkdownIt): void {
    for (const ext of this.extensions) {
      if (ext.configureMarkdownIt) {
        ext.configureMarkdownIt(md);
      }
    }
  }

  /**
   * Collect all parser token handlers from extensions.
   */
  buildParserTokens(): Record<string, any> {
    const tokens: Record<string, any> = {};

    for (const ext of this.extensions) {
      const extTokens = ext.parserTokens;
      Object.assign(tokens, extTokens);
    }

    return tokens;
  }

  // ── Serializer ──

  /**
   * Build MarkdownSerializer from all extensions' serializer contributions.
   */
  buildSerializer(): MarkdownSerializer {
    const nodes: Record<string, any> = {
      // Base nodes always included
      doc(state: any, node: any) {
        state.renderContent(node);
      },
      text(state: any, node: any) {
        state.text(node.text || '');
      },
      paragraph(state: any, node: any) {
        state.renderInline(node);
        state.closeBlock(node);
      },
      hard_break(state: any) {
        state.write('\\\n');
      },
    };

    const marks: Record<string, any> = {};

    for (const ext of this.extensions) {
      Object.assign(nodes, ext.serializerNodes);
      Object.assign(marks, ext.serializerMarks);
    }

    return new MarkdownSerializer(nodes, marks);
  }

  // ── UI ──

  /**
   * Collect slash menu items from all extensions.
   */
  buildSlashMenu(): SlashMenuItem[] {
    const items: SlashMenuItem[] = [];
    for (const ext of this.extensions) {
      items.push(...ext.slashMenuItems);
    }
    return items;
  }

  /**
   * Collect toolbar buttons from all extensions.
   */
  buildToolbarButtons(): ToolbarButton[] {
    const buttons: ToolbarButton[] = [];
    for (const ext of this.extensions) {
      buttons.push(...ext.toolbarButtons);
    }
    return buttons;
  }

  // ── Lifecycle ──

  /**
   * Call onInit on all extensions after EditorView is created.
   */
  initAll(view: EditorView): void {
    for (const ext of this.extensions) {
      if (ext.onInit) {
        ext.onInit(view);
      }
    }
  }

  /**
   * Call onDestroy on all extensions before editor is destroyed.
   */
  destroyAll(): void {
    for (const ext of this.extensions) {
      if (ext.onDestroy) {
        ext.onDestroy();
      }
    }
  }
}
