/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import type { GuardCommit } from '@easyview/contracts';
import { GRAPH_REF_COLOR, GRAPH_REMOTE_REF_COLOR, graphRows, renderGraph } from './guardGraph';

const commit = (hash: string, parents: string[], refs?: GuardCommit['refs']): GuardCommit => ({ hash, parents, message: hash, author: 'A', timestamp: 0, ...(refs ? { refs } : {}) });

describe('guardGraph', () => {
  it('keeps incoming upstream commits on their own lane and joins them at the shared parent', () => {
    // incoming (origin) and head (local) both branch off base.
    const rows = graphRows([
      commit('incoming', ['head'], [{ name: 'origin/main', type: 'remote' }]),
      commit('head', ['base'], [{ name: 'main', type: 'branch', current: true }]),
      commit('base', []),
    ], 'origin/main');
    expect(rows.map(row => row.current)).toEqual([false, true, false]);
    expect(rows[0]!.output).toEqual([{ id: 'head', color: GRAPH_REMOTE_REF_COLOR }]);
    expect(rows[1]!.input).toEqual([{ id: 'head', color: GRAPH_REMOTE_REF_COLOR }]);
    expect(rows[1]!.output).toEqual([{ id: 'base', color: GRAPH_REF_COLOR }]);
    expect(rows[2]!.output).toEqual([]);
  });

  it('opens a lane for each extra merge parent and closes it when the lanes meet again', () => {
    const rows = graphRows([
      commit('merge', ['main1', 'side1']),
      commit('side1', ['main1']),
      commit('main1', ['root']),
      commit('root', []),
    ]);
    expect(rows[0]!.output.map(lane => lane.id)).toEqual(['main1', 'side1']);
    expect(rows[1]!.output.map(lane => lane.id)).toEqual(['main1', 'main1']);
    expect(rows[2]!.input.map(lane => lane.id)).toEqual(['main1', 'main1']);
    expect(rows[2]!.output.map(lane => lane.id)).toEqual(['root']);
  });

  it('draws VS Code node shapes: hollow ring for HEAD, double circle for merges, dot otherwise', () => {
    const rows = graphRows([
      commit('head', ['merge'], [{ name: 'main', type: 'branch', current: true }]),
      commit('merge', ['a', 'b']),
      commit('a', []),
    ]);
    const circles = rows.map(row => renderGraph(row).querySelectorAll('circle'));
    expect(circles[0]!).toHaveLength(2);
    expect(circles[0]![1]!.getAttribute('class')).toBe('is-hole');
    expect(circles[1]!).toHaveLength(2);
    expect(circles[1]![1]!.getAttribute('class')).toBeNull();
    expect(circles[2]!).toHaveLength(1);
    expect(renderGraph(rows[1]!).style.width).toBe('33px');
  });
});
