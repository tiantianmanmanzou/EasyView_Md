/**
 * CodeBlockExtension
 *
 * Handles code block nodes: syntax highlighting, decorations,
 * input rules, keymaps, and serializer.
 */

import { textblockTypeInputRule, type InputRule } from 'prosemirror-inputrules';
import type { NodeSpec, Schema } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import type { Command } from 'prosemirror-commands';
import { setBlockType } from 'prosemirror-commands';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import { CodeHighlighting } from './CodeBlockHighlighting';
import { codeBlockDecorationsPlugin } from './CodeBlockDecorationsPlugin';

// ─── CodeBlock Extension ─────────────────────────────────────────────────────

export class CodeBlockExtension extends Extension {
  get name() {
    return 'codeBlock';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      code_block: {
        attrs: {
          language: { default: '', validate: 'string' },
        },
        content: 'text*',
        marks: '',
        group: 'block',
        code: true,
        defining: true,
        isolating: true,
        parseDOM: [
          {
            tag: 'pre',
            preserveWhitespace: 'full' as const,
            getAttrs(dom: HTMLPreElement) {
              const code = dom.querySelector('code');
              const className = code?.className || '';
              const match = className.match(/language-(\w+)/);
              return { language: match ? match[1] : '' };
            },
          },
        ],
        toDOM(node) {
          return [
            'pre',
            { class: `code-block${node.attrs.language ? ` language-${node.attrs.language}` : ''}` },
            ['code', { class: node.attrs.language ? `language-${node.attrs.language}` : '' }, 0],
          ];
        },
      },
    };
  }

  inputRules(schema: Schema): InputRule[] {
    return [
      textblockTypeInputRule(
        /^```([a-zA-Z]*)?[\s\n]$/,
        schema.nodes.code_block,
        (match) => ({ language: match[1] || '' })
      ),
    ];
  }

  keymaps(schema: Schema): Record<string, Command> {
    return {
      'Ctrl-Shift-c': setBlockType(schema.nodes.code_block),
    };
  }

  plugins(schema: Schema): Plugin[] {
    return [
      CodeHighlighting({ name: 'code_block', lineNumbers: true }),
      codeBlockDecorationsPlugin(),
    ];
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      code_block(state, node) {
        const lang = node.attrs.language || '';
        state.write(`\`\`\`${lang}\n`);
        state.text(node.textContent, false);
        state.write('\n```');
        state.closeBlock(node);
      },
    };
  }
}
