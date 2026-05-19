/**
 * Extension base class — each editor feature extends this.
 *
 * Inspired by Outline's Extension pattern.
 * Extensions contribute nodes, marks, plugins, input rules, keymaps,
 * NodeViews, parser/serializer rules, slash menu items, and toolbar buttons.
 */

import type { NodeSpec, MarkSpec, Schema } from 'prosemirror-model';
import type { Plugin, EditorState, Transaction } from 'prosemirror-state';
import type { InputRule } from 'prosemirror-inputrules';
import type { EditorView, NodeViewConstructor } from 'prosemirror-view';
import type { Command } from 'prosemirror-commands';
import type MarkdownIt from 'markdown-it';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as ProsemirrorNode, Mark } from 'prosemirror-model';

// ─── Types for parser/serializer contributions ─────────────────────────────

/**
 * Token handler for prosemirror-markdown's MarkdownParser.
 * Maps markdown-it token types to ProseMirror nodes/marks.
 */
export type ParserTokenHandler = {
  node?: string;
  block?: string;
  mark?: string;
  noCloseToken?: boolean;
  getAttrs?: (token: any, tokenStream: any[], index: number) => Record<string, any> | null;
  attrs?: Record<string, any>;
};

/**
 * Serializer handler for nodes.
 */
export type SerializerNodeHandler = (
  state: MarkdownSerializerState,
  node: ProsemirrorNode,
  parent: ProsemirrorNode,
  index: number
) => void;

/**
 * Serializer handler for marks.
 */
export type SerializerMarkHandler = {
  open: string | ((state: MarkdownSerializerState, mark: Mark, parent: ProsemirrorNode, index: number) => string);
  close: string | ((state: MarkdownSerializerState, mark: Mark, parent: ProsemirrorNode, index: number) => string);
  mixable?: boolean;
  expelEnclosingWhitespace?: boolean;
  escape?: boolean;
};

// ─── UI types ───────────────────────────────────────────────────────────────

export interface SlashMenuItem {
  /** Displayed label */
  label: string;
  /** Keywords for filtering (includes label automatically) */
  keywords: string[];
  /** SVG icon string */
  icon: string;
  /** Action when item is selected */
  action: (view: EditorView) => void;
  /** Group for ordering */
  group?: string;
}

export interface ToolbarButton {
  /** Unique button name */
  name: string;
  /** SVG icon string */
  icon: string;
  /** Check if button should show active state */
  isActive: (state: EditorState) => boolean;
  /** Command to execute on click */
  command: Command;
  /** Button group for layout */
  group?: 'format' | 'block' | 'insert';
  /** Tooltip text */
  title?: string;
}

// ─── Extension base class ───────────────────────────────────────────────────

export abstract class Extension {
  /** Unique name, e.g. "math", "table", "heading" */
  abstract get name(): string;

  // ── Schema contributions ──

  /** Node specs to add to the schema */
  get nodes(): Record<string, NodeSpec> {
    return {};
  }

  /** Mark specs to add to the schema */
  get marks(): Record<string, MarkSpec> {
    return {};
  }

  // ── Editor behavior ──

  /** ProseMirror plugins. Receives the built schema for reference. */
  plugins(_schema: Schema): Plugin[] {
    return [];
  }

  /** Input rules for markdown shortcuts */
  inputRules(_schema: Schema): InputRule[] {
    return [];
  }

  /** Keymaps: key → command. Merged into a single keymap plugin. */
  keymaps(_schema: Schema): Record<string, Command> {
    return {};
  }

  // ── NodeViews ──

  /** NodeView constructors keyed by node name */
  get nodeViews(): Record<string, NodeViewConstructor> {
    return {};
  }

  // ── Parser contributions (markdown-it rules + token mapping) ──

  /** Token handlers for prosemirror-markdown parser */
  get parserTokens(): Record<string, ParserTokenHandler> {
    return {};
  }

  /** Configure markdown-it instance (add plugins, custom rules) */
  configureMarkdownIt?(_md: MarkdownIt): void;

  // ── Serializer contributions ──

  /** Node serializer handlers */
  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {};
  }

  /** Mark serializer handlers */
  get serializerMarks(): Record<string, SerializerMarkHandler> {
    return {};
  }

  // ── UI ──

  /** Slash menu items this extension provides */
  get slashMenuItems(): SlashMenuItem[] {
    return [];
  }

  /** Toolbar buttons this extension provides */
  get toolbarButtons(): ToolbarButton[] {
    return [];
  }

  // ── Lifecycle ──

  /** Called after EditorView is created */
  onInit?(_view: EditorView): void;

  /** Called before editor is destroyed */
  onDestroy?(): void;
}
