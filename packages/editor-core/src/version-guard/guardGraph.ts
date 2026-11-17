import type { GuardCommit } from '@easyview/contracts';

/** Swimlane geometry and colors follow the VS Code SCM graph (`scmHistory.ts`); the row height matches the windowed history list. */
export const GRAPH_ROW_HEIGHT = 26;
const LANE_WIDTH = 11;
const MID = GRAPH_ROW_HEIGHT / 2;
const CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE = 2;
export const GRAPH_REF_COLOR = 'var(--vscode-scmGraph-historyItemRefColor,#59a4f9)';
export const GRAPH_REMOTE_REF_COLOR = 'var(--vscode-scmGraph-historyItemRemoteRefColor,#b180d7)';
const LANE_COLORS = [
  'var(--vscode-scmGraph-foreground1,#ffb000)',
  'var(--vscode-scmGraph-foreground2,#dc267f)',
  'var(--vscode-scmGraph-foreground3,#994f00)',
  'var(--vscode-scmGraph-foreground4,#40b0a6)',
  'var(--vscode-scmGraph-foreground5,#b66dff)',
];

interface Lane { id: string; color: string }
export interface GraphRow { commit: GuardCommit; current: boolean; input: Lane[]; output: Lane[] }

/**
 * Lanes carry the commit each one waits for. A commit continues the lane that expects it with its
 * first parent; further parents open new lanes. Commits decorated with the current branch or its
 * upstream color their lane like VS Code; other lanes rotate through the graph palette.
 */
export function graphRows(commits: GuardCommit[], upstream?: string): GraphRow[] {
  const labelColor = (commit: GuardCommit | undefined): string | undefined => {
    for (const ref of commit?.refs ?? []) {
      if (ref.current) return GRAPH_REF_COLOR;
      if (ref.type === 'remote' && ref.name === upstream) return GRAPH_REMOTE_REF_COLOR;
    }
    return undefined;
  };
  const byHash = new Map(commits.map(commit => [commit.hash, commit]));
  const rows: GraphRow[] = [];
  let colorIndex = -1;
  const nextColor = (): string => LANE_COLORS[colorIndex = (colorIndex + 1) % LANE_COLORS.length]!;
  for (const commit of commits) {
    const input = rows.at(-1)?.output.map(lane => ({ ...lane })) ?? [];
    const output: Lane[] = [];
    let firstParentAdded = false;
    for (const lane of input) {
      if (lane.id !== commit.hash) { output.push({ ...lane }); continue; }
      if (!firstParentAdded && commit.parents.length) { output.push({ id: commit.parents[0]!, color: labelColor(commit) ?? lane.color }); firstParentAdded = true; }
    }
    for (let i = firstParentAdded ? 1 : 0; i < commit.parents.length; i++) {
      const color = labelColor(i === 0 ? commit : byHash.get(commit.parents[i]!)) ?? nextColor();
      output.push({ id: commit.parents[i]!, color });
    }
    rows.push({ commit, current: !!commit.refs?.some(ref => ref.current), input, output });
  }
  return rows;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function path(d: string, color: string): SVGPathElement {
  const element = document.createElementNS(SVG_NS, 'path'); element.setAttribute('d', d); element.style.stroke = color; return element;
}
function circle(index: number, radius: number, color: string | undefined, className?: string): SVGCircleElement {
  const element = document.createElementNS(SVG_NS, 'circle');
  element.setAttribute('cx', String(LANE_WIDTH * (index + 1))); element.setAttribute('cy', String(MID)); element.setAttribute('r', String(radius));
  element.style.strokeWidth = `${CIRCLE_STROKE}px`; if (color) element.style.fill = color; if (className) element.setAttribute('class', className);
  return element;
}

export function renderGraph(row: GraphRow): SVGSVGElement {
  const { commit, input, output } = row;
  const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('class', 'guard-graph'); svg.setAttribute('aria-hidden', 'true');
  const inputIndex = input.findIndex(lane => lane.id === commit.hash);
  const circleIndex = inputIndex !== -1 ? inputIndex : input.length;
  const circleColor = output[circleIndex]?.color ?? input[circleIndex]?.color ?? GRAPH_REF_COLOR;
  let outputIndex = 0;
  for (let index = 0; index < input.length; index++) {
    const lane = input[index]!;
    if (lane.id === commit.hash) {
      // Another lane also waited for this commit: merge it into the node.
      if (index !== circleIndex) svg.append(path(`M ${LANE_WIDTH * (index + 1)} 0 A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * index} ${MID} H ${LANE_WIDTH * (circleIndex + 1)}`, lane.color));
      else outputIndex++;
      continue;
    }
    if (outputIndex >= output.length || lane.id !== output[outputIndex]!.id) continue;
    if (index === outputIndex) svg.append(path(`M ${LANE_WIDTH * (index + 1)} 0 V ${GRAPH_ROW_HEIGHT}`, lane.color));
    else svg.append(path(`M ${LANE_WIDTH * (index + 1)} 0 V ${MID - CURVE_RADIUS} A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 1 ${LANE_WIDTH * (index + 1) - CURVE_RADIUS} ${MID} H ${LANE_WIDTH * (outputIndex + 1) + CURVE_RADIUS} A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 0 ${LANE_WIDTH * (outputIndex + 1)} ${MID + CURVE_RADIUS} V ${GRAPH_ROW_HEIGHT}`, lane.color));
    outputIndex++;
  }
  for (let i = 1; i < commit.parents.length; i++) {
    let parentIndex = -1;
    for (let j = output.length - 1; j >= 0; j--) if (output[j]!.id === commit.parents[i]) { parentIndex = j; break; }
    if (parentIndex === -1) continue;
    svg.append(path(`M ${LANE_WIDTH * parentIndex} ${MID} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * (parentIndex + 1)} ${GRAPH_ROW_HEIGHT} M ${LANE_WIDTH * parentIndex} ${MID} H ${LANE_WIDTH * (circleIndex + 1)}`, output[parentIndex]!.color));
  }
  const x = LANE_WIDTH * (circleIndex + 1);
  if (inputIndex !== -1) svg.append(path(`M ${x} 0 V ${MID}`, input[inputIndex]!.color));
  if (commit.parents.length) svg.append(path(`M ${x} ${MID} V ${GRAPH_ROW_HEIGHT}`, circleColor));
  if (row.current) svg.append(circle(circleIndex, CIRCLE_RADIUS + 3, circleColor), circle(circleIndex, CIRCLE_RADIUS, undefined, 'is-hole'));
  else if (commit.parents.length > 1) svg.append(circle(circleIndex, CIRCLE_RADIUS + 2, circleColor), circle(circleIndex, CIRCLE_RADIUS - 1, circleColor));
  else svg.append(circle(circleIndex, CIRCLE_RADIUS + 1, circleColor));
  svg.style.width = `${LANE_WIDTH * (Math.max(input.length, output.length, 1) + 1)}px`; svg.style.height = `${GRAPH_ROW_HEIGHT}px`;
  return svg;
}
