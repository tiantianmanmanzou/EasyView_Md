/**
 * MathExtension — KaTeX-rendered math expressions for ProseMirror.
 *
 * Uses @benrbray/prosemirror-math for NodeViews (MathView) and the math plugin.
 * Provides inline math ($...$) and block math ($$...$$) with live KaTeX rendering.
 *
 * Schema nodes are defined in EditorSchema.ts.
 * Parsing rules are in MarkdownParser.ts (inline/block math rules + ```math fence support).
 * Serialization is in MarkdownSerializer.ts.
 */

import { InputRule } from 'prosemirror-inputrules';
import type { Schema } from 'prosemirror-model';
import type { Plugin, Command } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import {
  MathView,
  mathBackspaceCmd,
  insertMathCmd,
  makeBlockMathInputRule,
} from '@benrbray/prosemirror-math';
import { Extension, type SlashMenuItem } from '../../../editor/EditorExtension';
import { createMathPlugin } from './MathPlugin';
import { isInCode } from './mathUtils';

// ─── Regex ──────────────────────────────────────────────────────────────────

/** Matches: $content$$ at end of line — for inline math input rule */
const REGEX_INLINE_MATH_DOLLARS = /\$\$(.+)\$\$$/;

/** Matches: $$$  (followed by space) at end of line — for block math input rule */
const REGEX_BLOCK_MATH_DOLLARS = /\$\$\$\s+$/;

// ─── MathExtension ──────────────────────────────────────────────────────────

export class MathExtension extends Extension {
  get name() {
    return 'math';
  }

  inputRules(schema: Schema): InputRule[] {
    const rules: InputRule[] = [];

    // Inline math: type $$content$$ → converts to math_inline node
    rules.push(
      new InputRule(REGEX_INLINE_MATH_DOLLARS, (state, match, start, end) => {
        if (isInCode(state)) return null;

        const $start = state.doc.resolve(start);
        const $end = state.doc.resolve(end);

        if (!$start.parent.canReplaceWith(
          $start.index(),
          $end.index(),
          schema.nodes.math_inline
        )) {
          return null;
        }

        return state.tr.replaceRangeWith(
          start,
          end,
          schema.nodes.math_inline.create(
            undefined,
            schema.text(match[1])
          )
        );
      })
    );

    // Block math: type $$$ then space → creates math_block node
    rules.push(
      makeBlockMathInputRule(REGEX_BLOCK_MATH_DOLLARS, schema.nodes.math_block)
    );

    return rules;
  }

  keymaps(schema: Schema): Record<string, Command> {
    return {
      'Mod-Space': insertMathCmd(schema.nodes.math_inline),
      Backspace: mathBackspaceCmd,
    };
  }

  plugins(_schema: Schema): Plugin[] {
    return [createMathPlugin()];
  }

  get slashMenuItems(): SlashMenuItem[] {
    return [
      {
        label: 'Math (inline)',
        keywords: ['math', 'formula', 'equation', 'latex', 'katex', 'inline'],
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
        group: 'insert',
        action(view: EditorView) {
          const { state, dispatch } = view;
          const node = state.schema.nodes.math_inline.create(undefined, state.schema.text('E = mc^2'));
          dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
          view.focus();
        },
      },
      {
        label: 'Math block',
        keywords: ['math', 'formula', 'equation', 'latex', 'katex', 'block', 'display'],
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 8l3 4-3 4"/><path d="M14 8h3"/><path d="M14 16h3"/></svg>',
        group: 'insert',
        action(view: EditorView) {
          const { state, dispatch } = view;
          const node = state.schema.nodes.math_block.create(
            undefined,
            state.schema.text('\\int_0^\\infty e^{-x} dx = 1')
          );
          const tr = state.tr.replaceSelectionWith(node);
          dispatch(
            tr.setSelection(
              TextSelection.near(tr.doc.resolve(state.selection.from - 1))
            ).scrollIntoView()
          );
          view.focus();
        },
      },
    ];
  }
}
