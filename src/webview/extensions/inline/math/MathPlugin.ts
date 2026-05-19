/**
 * MathPlugin — ProseMirror plugin providing MathView NodeViews for KaTeX rendering.
 *
 * Copied from Outline's extensions/Math.ts with adaptations:
 * - Uses dynamic import for KaTeX CSS (loaded once on first math view creation)
 * - Tracks active MathView instances for lifecycle management
 * - Supports custom LaTeX macros via plugin state
 */

import { MathView } from '@benrbray/prosemirror-math';
import type { PluginSpec } from 'prosemirror-state';
import { Plugin, PluginKey } from 'prosemirror-state';
import type { NodeViewConstructor } from 'prosemirror-view';

// ─── Plugin State ───────────────────────────────────────────────────────────

export interface MathPluginState {
  macros: Record<string, string>;
  activeNodeViews: MathView[];
  prevCursorPos: number;
}

const MATH_PLUGIN_KEY = new PluginKey<MathPluginState>('prosemirror-math');

// ─── MathView Factory ───────────────────────────────────────────────────────
// KaTeX CSS is loaded statically via @import in math.css

function createMathView(displayMode: boolean): NodeViewConstructor {
  return (node, view, getPos) => {

    const pluginState = MATH_PLUGIN_KEY.getState(view.state);
    if (!pluginState) {
      throw new Error('[MathPlugin] No math plugin state found');
    }

    const nodeViews = pluginState.activeNodeViews;

    const nodeView = new MathView(
      node,
      view,
      getPos as () => number,
      {
        katexOptions: {
          displayMode,
          output: 'html',
          macros: pluginState.macros,
          throwOnError: false,
        },
      },
      MATH_PLUGIN_KEY,
      () => {
        // Cleanup: remove from active list when destroyed
        const idx = nodeViews.indexOf(nodeView);
        if (idx >= 0) nodeViews.splice(idx, 1);
      }
    );

    nodeViews.push(nodeView);
    return nodeView;
  };
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export function createMathPlugin(): Plugin {
  const spec: PluginSpec<MathPluginState> = {
    key: MATH_PLUGIN_KEY,
    state: {
      init(): MathPluginState {
        return {
          macros: {},
          activeNodeViews: [],
          prevCursorPos: 0,
        };
      },
      apply(tr, value, oldState): MathPluginState {
        return {
          activeNodeViews: value.activeNodeViews,
          macros: value.macros,
          prevCursorPos: oldState.selection.from,
        };
      },
    },
    props: {
      nodeViews: {
        math_inline: createMathView(false),
        math_block: createMathView(true),
      },
    },
  };

  return new Plugin(spec);
}
