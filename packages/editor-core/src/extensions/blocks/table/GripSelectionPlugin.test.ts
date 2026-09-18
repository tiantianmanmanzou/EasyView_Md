/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../../../editor/EditorSchema';
import { gripSelectionKey, gripSelectionPlugin } from './GripSelectionPlugin';

function createState() {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('hello world')]),
  ]);
  return EditorState.create({
    doc,
    plugins: [gripSelectionPlugin()],
  });
}

describe('GripSelectionPlugin', () => {
  it('clears grip mode on the next selection change without pointer meta', () => {
    let state = createState();

    state = state.apply(
      state.tr
        .setSelection(TextSelection.create(state.doc, 1, 5))
        .setMeta('gripSelection', true)
    );
    expect(gripSelectionKey.getState(state)?.isGripSelection).toBe(true);

    // Keyboard / delayed selection updates often omit `pointer` meta.
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, 8))
    );
    expect(gripSelectionKey.getState(state)?.isGripSelection).toBe(false);
  });

  it('keeps grip mode only for the grip-marked transaction itself', () => {
    let state = createState();
    state = state.apply(
      state.tr
        .setSelection(TextSelection.create(state.doc, 1, 3))
        .setMeta('gripSelection', true)
    );
    expect(gripSelectionKey.getState(state)?.isGripSelection).toBe(true);

    // Non-selection transactions must not clear the flag prematurely.
    state = state.apply(state.tr.setMeta('addToHistory', false));
    expect(gripSelectionKey.getState(state)?.isGripSelection).toBe(true);
  });
});
