// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import type { Plugin } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import { AiChangesExtension, GIT_CHANGE_META } from './AiChangesExtension';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
});

it('keeps Git decorations after transient AI decorations are cleared', () => {
  const plugin = new AiChangesExtension().plugins(schema)[0] as Plugin;
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('changed')])]),
    plugins: [plugin],
  });

  state = state.apply(state.tr.setMeta(GIT_CHANGE_META, {
    revision: 1,
    markdown: 'changed',
    lineRanges: [{ startLine: 1, endLine: 1, kind: 'modified' }],
  }));
  const decorations = () => plugin.props.decorations!.call(plugin, state) as DecorationSet;
  expect(decorations().find()).toHaveLength(1);

  state = state.apply(state.tr.setMeta('externalChange', true));
  expect(decorations().find()).toHaveLength(2);

  state = state.apply(state.tr.setMeta('aiChangesClear', true));
  expect(decorations().find()).toHaveLength(1);

  state = state.apply(state.tr.setMeta(GIT_CHANGE_META, {
    revision: 2,
    markdown: 'changed',
    lineRanges: [],
  }));
  expect(decorations().find()).toHaveLength(0);
});
