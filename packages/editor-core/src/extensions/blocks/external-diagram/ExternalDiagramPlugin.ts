import last from 'lodash/last';
import sortBy from 'lodash/sortBy';
import { deflate } from 'pako';
import { v4 as uuidv4 } from 'uuid';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import { layoutProcess } from 'bpmn-auto-layout';
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { getExternalDiagramType, isCode } from '../../../editor/lib/CodeDetection';
import { findBlockNodes, type NodeWithPos, findParentNode } from '../../../editor/lib/NodeFinder';

export const pluginKey = new PluginKey('externalDiagram');

type ExternalDiagramType = 'graphviz' | 'd2' | 'bpmn';

type ExternalDiagramState = {
  decorationSet: DecorationSet;
  editingId?: string;
};

const KROKI_SERVER = 'https://kroki.io';

class Cache {
  static get(key: string) {
    return this.data.get(key);
  }

  static set(key: string, value: string) {
    this.data.set(key, value);
    if (this.data.size > this.maxSize) {
      const oldest = this.data.keys().next().value;
      if (oldest !== undefined) this.data.delete(oldest);
    }
  }

  private static maxSize = 30;
  private static data = new Map<string, string>();
}

class BpmnLayoutCache {
  static get(key: string) {
    return this.data.get(key);
  }

  static set(key: string, value: string) {
    this.data.set(key, value);
    if (this.data.size > this.maxSize) {
      const oldest = this.data.keys().next().value;
      if (oldest !== undefined) this.data.delete(oldest);
    }
  }

  private static maxSize = 20;
  private static data = new Map<string, string>();
}

class ExternalDiagramRenderer {
  readonly diagramId: string;
  readonly element: HTMLElement;
  readonly elementId: string;

  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  private viewport: HTMLDivElement | null = null;
  private imageContainer: HTMLDivElement | null = null;
  private bpmnViewer: any = null;
  private renderToken = 0;

  constructor() {
    this.diagramId = uuidv4();
    this.elementId = `external-diagram-wrapper-${this.diagramId}`;
    this.element = document.getElementById(this.elementId) || document.createElement('div');
    this.element.id = this.elementId;
    this.element.classList.add('mermaid-diagram-wrapper', 'external-diagram-wrapper');
  }

  private resetZoomPan() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  private applyTransform() {
    if (this.imageContainer) {
      this.imageContainer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    }
  }

  private setupZoomPan(element: HTMLElement) {
    const viewport = document.createElement('div');
    viewport.className = 'mermaid-viewport external-diagram-viewport';

    const imageContainer = document.createElement('div');
    imageContainer.className = 'mermaid-svg-container external-diagram-image-container';

    while (element.firstChild) {
      imageContainer.appendChild(element.firstChild);
    }
    viewport.appendChild(imageContainer);

    const controls = document.createElement('div');
    controls.className = 'mermaid-zoom-controls external-diagram-zoom-controls';

    const zoomIn = document.createElement('button');
    zoomIn.className = 'mermaid-zoom-btn';
    zoomIn.textContent = '+';
    zoomIn.title = 'Zoom in';
    zoomIn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.scale = Math.min(this.scale * 1.25, 5);
      this.applyTransform();
    });

    const zoomOut = document.createElement('button');
    zoomOut.className = 'mermaid-zoom-btn';
    zoomOut.textContent = '-';
    zoomOut.title = 'Zoom out';
    zoomOut.addEventListener('click', (event) => {
      event.stopPropagation();
      this.scale = Math.max(this.scale / 1.25, 0.2);
      this.applyTransform();
    });

    const zoomReset = document.createElement('button');
    zoomReset.className = 'mermaid-zoom-btn';
    zoomReset.textContent = '1:1';
    zoomReset.title = 'Reset zoom';
    zoomReset.addEventListener('click', (event) => {
      event.stopPropagation();
      this.resetZoomPan();
    });

    controls.append(zoomIn, zoomOut, zoomReset);
    element.append(viewport, controls);

    this.viewport = viewport;
    this.imageContainer = imageContainer;

    viewport.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.scale = Math.min(Math.max(this.scale * factor, 0.2), 5);
      this.applyTransform();
    }, { passive: false });

    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let startTranslateX = 0;
    let startTranslateY = 0;

    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      isPanning = true;
      panStartX = event.clientX;
      panStartY = event.clientY;
      startTranslateX = this.translateX;
      startTranslateY = this.translateY;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('panning');
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!isPanning) return;
      this.translateX = startTranslateX + (event.clientX - panStartX);
      this.translateY = startTranslateY + (event.clientY - panStartY);
      this.applyTransform();
    });

    const endPan = (event: PointerEvent) => {
      if (!isPanning) return;
      isPanning = false;
      viewport.releasePointerCapture(event.pointerId);
      viewport.classList.remove('panning');
    };

    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);
  }

  render(block: { node: Node; pos: number }) {
    const diagramType = getExternalDiagramType(block.node);
    const source = block.node.textContent.trim();

    if (!diagramType || !source) {
      this.element.classList.add('empty');
      this.element.classList.remove('parse-error');
      this.element.textContent = 'Empty diagram';
      return;
    }

    this.destroyBpmnViewer();
    const cacheKey = `${diagramType}\n${source}`;
    if (diagramType === 'bpmn') {
      void this.renderBpmn(source, cacheKey);
      return;
    }

    const cachedUrl = Cache.get(cacheKey);
    const url = cachedUrl ?? createKrokiSvgUrl(diagramType, source);
    if (!cachedUrl) Cache.set(cacheKey, url);

    this.element.classList.remove('empty', 'parse-error');
    this.element.innerHTML = '';

    const image = document.createElement('img');
    image.src = url;
    image.alt = `${diagramType} diagram`;
    image.decoding = 'async';
    image.loading = 'lazy';
    image.draggable = false;
    image.className = 'external-diagram-image';
    image.addEventListener('error', () => {
      this.element.classList.add('parse-error');
      this.element.textContent = `Failed to render ${diagramType} diagram`;
    }, { once: true });

    this.element.appendChild(image);
    this.resetZoomPan();
    this.setupZoomPan(this.element);
  }

  private destroyBpmnViewer() {
    if (this.bpmnViewer) {
      try {
        this.bpmnViewer.destroy();
      } catch {
        // Ignore stale viewer cleanup failures.
      }
      this.bpmnViewer = null;
    }
  }

  private async renderBpmn(source: string, cacheKey: string) {
    const token = ++this.renderToken;
    this.element.classList.remove('empty', 'parse-error');
    this.element.classList.add('bpmn-diagram-wrapper');
    this.element.innerHTML = '';

    const canvas = document.createElement('div');
    canvas.className = 'external-bpmn-canvas';
    canvas.style.width = '100%';
    canvas.style.height = `${Math.min(Math.max(source.split('\n').length * 18, 420), 900)}px`;
    this.element.appendChild(canvas);

    try {
      const xml = await normalizeBpmnForRendering(source, cacheKey);
      if (token !== this.renderToken) return;

      const viewer = new BpmnViewer({ container: canvas });
      this.bpmnViewer = viewer;
      await viewer.importXML(xml);

      if (token !== this.renderToken) {
        viewer.destroy();
        return;
      }

      const viewerCanvas = viewer.get('canvas') as { zoom: (level: string, center?: string) => void };
      viewerCanvas.zoom('fit-viewport', 'auto');
    } catch (error) {
      if (token !== this.renderToken) return;
      this.destroyBpmnViewer();
      this.element.classList.add('parse-error');
      this.element.textContent = `Failed to render BPMN diagram: ${formatErrorMessage(error)}`;
    }
  }
}

function hasBpmnDiagramInterchange(source: string): boolean {
  return /<(?:\w+:)?BPMNDiagram\b/i.test(source) && /<(?:\w+:)?BPMNPlane\b/i.test(source);
}

async function normalizeBpmnForRendering(source: string, cacheKey: string): Promise<string> {
  if (hasBpmnDiagramInterchange(source)) {
    return source;
  }

  const cached = BpmnLayoutCache.get(cacheKey);
  if (cached) return cached;

  const layouted = createLaneAwareBpmnDi(source) ?? await layoutProcess(source);
  BpmnLayoutCache.set(cacheKey, layouted);
  return layouted;
}

function createLaneAwareBpmnDi(source: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const definitions = firstByLocalName(doc, 'definitions');
  const process = firstByLocalName(doc, 'process');
  const laneSet = firstByLocalName(doc, 'laneSet');
  if (!definitions || !process || !laneSet) return null;

  ensureNamespace(definitions, 'xmlns:bpmndi', 'http://www.omg.org/spec/BPMN/20100524/DI');
  ensureNamespace(definitions, 'xmlns:dc', 'http://www.omg.org/spec/DD/20100524/DC');
  ensureNamespace(definitions, 'xmlns:di', 'http://www.omg.org/spec/DD/20100524/DI');

  const lanes = childrenByLocalName(laneSet, 'lane');
  if (!lanes.length) return null;

  const laneByNodeId = new Map<string, Element>();
  lanes.forEach((lane) => {
    childrenByLocalName(lane, 'flowNodeRef').forEach((ref) => {
      const nodeId = (ref.textContent || '').trim();
      if (nodeId) laneByNodeId.set(nodeId, lane);
    });
  });

  const nodes = childrenByLocalNames(process, [
    'startEvent',
    'endEvent',
    'task',
    'userTask',
    'serviceTask',
    'manualTask',
    'scriptTask',
    'businessRuleTask',
    'exclusiveGateway',
    'parallelGateway',
    'inclusiveGateway',
  ]).filter((node) => node.getAttribute('id'));
  const flows = childrenByLocalName(process, 'sequenceFlow')
    .filter((flow) => flow.getAttribute('sourceRef') && flow.getAttribute('targetRef'));
  if (!nodes.length) return null;

  const nodeOrder = new Map<string, number>();
  nodes.forEach((node, index) => nodeOrder.set(node.getAttribute('id') || '', index));

  const laneIndex = new Map<Element, number>();
  lanes.forEach((lane, index) => laneIndex.set(lane, index));

  const laneHeight = 150;
  const left = 80;
  const top = 70;
  const columnGap = 190;
  const laneHeaderWidth = 130;
  const maxX = left + laneHeaderWidth + Math.max(1, nodes.length - 1) * columnGap + 220;
  const totalHeight = top + lanes.length * laneHeight + 40;

  const shapeBounds = new Map<string, { x: number; y: number; width: number; height: number }>();
  const bpmndi = 'http://www.omg.org/spec/BPMN/20100524/DI';
  const dc = 'http://www.omg.org/spec/DD/20100524/DC';
  const di = 'http://www.omg.org/spec/DD/20100524/DI';
  const processId = process.getAttribute('id') || 'Process';

  const diagram = doc.createElementNS(bpmndi, 'bpmndi:BPMNDiagram');
  diagram.setAttribute('id', `BPMNDiagram_${processId}`);
  const plane = doc.createElementNS(bpmndi, 'bpmndi:BPMNPlane');
  plane.setAttribute('id', `BPMNPlane_${processId}`);
  plane.setAttribute('bpmnElement', processId);
  diagram.appendChild(plane);

  lanes.forEach((lane, index) => {
    const laneId = lane.getAttribute('id') || `Lane_${index + 1}`;
    const bounds = {
      x: left,
      y: top + index * laneHeight,
      width: maxX - left - 40,
      height: laneHeight,
    };
    plane.appendChild(createShape(doc, bpmndi, dc, `${laneId}_di`, laneId, bounds));
  });

  nodes.forEach((node) => {
    const id = node.getAttribute('id') || '';
    const lane = laneByNodeId.get(id) || lanes[0];
    const row = laneIndex.get(lane) ?? 0;
    const index = nodeOrder.get(id) ?? 0;
    const size = getBpmnNodeSize(node);
    const bounds = {
      x: left + laneHeaderWidth + index * columnGap,
      y: top + row * laneHeight + Math.round((laneHeight - size.height) / 2),
      width: size.width,
      height: size.height,
    };
    shapeBounds.set(id, bounds);
    plane.appendChild(createShape(doc, bpmndi, dc, `${id}_di`, id, bounds, isGateway(node)));
  });

  flows.forEach((flow, index) => {
    const id = flow.getAttribute('id') || `Flow_${index + 1}`;
    const sourceId = flow.getAttribute('sourceRef') || '';
    const targetId = flow.getAttribute('targetRef') || '';
    const sourceBounds = shapeBounds.get(sourceId);
    const targetBounds = shapeBounds.get(targetId);
    if (!sourceBounds || !targetBounds) return;

    const edge = doc.createElementNS(bpmndi, 'bpmndi:BPMNEdge');
    edge.setAttribute('id', `${id}_di`);
    edge.setAttribute('bpmnElement', id);
    getWaypoints(sourceBounds, targetBounds).forEach((point) => {
      const waypoint = doc.createElementNS(di, 'di:waypoint');
      waypoint.setAttribute('x', String(point.x));
      waypoint.setAttribute('y', String(point.y));
      edge.appendChild(waypoint);
    });
    plane.appendChild(edge);
  });

  definitions.appendChild(diagram);
  return new XMLSerializer().serializeToString(doc);
}

function firstByLocalName(root: ParentNode, localName: string): Element | null {
  return Array.from(root.querySelectorAll('*')).find((element) => element.localName === localName) ?? null;
}

function childrenByLocalName(root: Element, localName: string): Element[] {
  return Array.from(root.children).filter((element) => element.localName === localName);
}

function childrenByLocalNames(root: Element, localNames: string[]): Element[] {
  const allowed = new Set(localNames);
  return Array.from(root.children).filter((element) => allowed.has(element.localName));
}

function ensureNamespace(element: Element, attr: string, value: string) {
  if (!element.hasAttribute(attr)) element.setAttribute(attr, value);
}

function isGateway(node: Element): boolean {
  return node.localName.toLowerCase().includes('gateway');
}

function getBpmnNodeSize(node: Element): { width: number; height: number } {
  if (node.localName.endsWith('Event')) return { width: 36, height: 36 };
  if (isGateway(node)) return { width: 50, height: 50 };
  return { width: 140, height: 70 };
}

function createShape(
  doc: XMLDocument,
  bpmndi: string,
  dc: string,
  id: string,
  bpmnElement: string,
  bounds: { x: number; y: number; width: number; height: number },
  isMarkerVisible = false,
): Element {
  const shape = doc.createElementNS(bpmndi, 'bpmndi:BPMNShape');
  shape.setAttribute('id', id);
  shape.setAttribute('bpmnElement', bpmnElement);
  if (isMarkerVisible) shape.setAttribute('isMarkerVisible', 'true');
  const dcBounds = doc.createElementNS(dc, 'dc:Bounds');
  dcBounds.setAttribute('x', String(bounds.x));
  dcBounds.setAttribute('y', String(bounds.y));
  dcBounds.setAttribute('width', String(bounds.width));
  dcBounds.setAttribute('height', String(bounds.height));
  shape.appendChild(dcBounds);
  return shape;
}

function getWaypoints(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): Array<{ x: number; y: number }> {
  const start = { x: source.x + source.width, y: source.y + source.height / 2 };
  const end = { x: target.x, y: target.y + target.height / 2 };
  if (Math.abs(start.y - end.y) < 2) return [start, end];

  const midX = Math.round((start.x + end.x) / 2);
  return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createKrokiSvgUrl(type: ExternalDiagramType, source: string): string {
  const bytes = new TextEncoder().encode(source);
  const compressed = deflate(bytes, { level: 9 });
  const encoded = toUrlSafeBase64(compressed);
  return `${KROKI_SERVER}/${type}/svg/${encoded}`;
}

function toUrlSafeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
}

function overlap(start1: number, end1: number, start2: number, end2: number): number {
  return Math.max(0, Math.min(end1, end2) - Math.max(start1, start2));
}

function findBestOverlapDecoration(
  decorations: Decoration[],
  block: NodeWithPos,
): Decoration | undefined {
  if (decorations.length === 0) return undefined;
  return last(
    sortBy(decorations, (decoration) =>
      overlap(decoration.from, decoration.to, block.pos, block.pos + block.node.nodeSize),
    ),
  );
}

function getNewState(doc: Node, pluginState: ExternalDiagramState): ExternalDiagramState {
  const decorations: Decoration[] = [];
  const allBlocks = findBlockNodes(doc, true);
  const blocks = allBlocks.filter((item) => getExternalDiagramType(item.node));

  blocks.forEach((block) => {
    const existingDecorations = pluginState.decorationSet.find(
      block.pos,
      block.pos + block.node.nodeSize,
      (spec) => !!spec.diagramId,
    );
    const bestDecoration = findBestOverlapDecoration(existingDecorations, block);
    const renderer: ExternalDiagramRenderer =
      bestDecoration?.spec?.renderer ?? new ExternalDiagramRenderer();

    const widgetDecoration = Decoration.widget(
      block.pos + block.node.nodeSize,
      () => {
        renderer.render(block);
        return renderer.element;
      },
      {
        diagramId: renderer.diagramId,
        renderer,
        side: -10,
      },
    );

    const nodeDecoration = Decoration.node(
      block.pos,
      block.pos + block.node.nodeSize,
      {},
      {
        diagramId: renderer.diagramId,
        renderer,
      },
    );

    decorations.push(widgetDecoration, nodeDecoration);
  });

  return {
    ...pluginState,
    decorationSet: DecorationSet.create(doc, decorations),
  };
}

export default function ExternalDiagramPlugin() {
  return new Plugin({
    key: pluginKey,
    state: {
      init: (_, { doc }) => getNewState(doc, { decorationSet: DecorationSet.create(doc, []) }),
      apply(transaction: Transaction, pluginState: ExternalDiagramState) {
        const diagramMeta = transaction.getMeta(pluginKey);
        const nextState: ExternalDiagramState = {
          ...pluginState,
          editingId:
            diagramMeta && 'editingId' in diagramMeta
              ? diagramMeta.editingId
              : pluginState.editingId,
          decorationSet: pluginState.decorationSet.map(transaction.mapping, transaction.doc),
        };

        if (transaction.selectionSet && nextState.editingId && !diagramMeta) {
          const codeBlock = findParentNode(isCode)(transaction.selection);
          let isEditing = codeBlock && !!getExternalDiagramType(codeBlock.node);

          if (isEditing && codeBlock && !transaction.docChanged) {
            const decorations = nextState.decorationSet.find(
              codeBlock.pos,
              codeBlock.pos + codeBlock.node.nodeSize,
            );
            const nodeDecoration = decorations.find(
              (decoration) => decoration.spec.diagramId && decoration.from === codeBlock.pos,
            );
            if (nodeDecoration?.spec.diagramId !== nextState.editingId) {
              isEditing = false;
            }
          }

          if (!isEditing) nextState.editingId = undefined;
        }

        if (transaction.docChanged || diagramMeta) {
          return getNewState(transaction.doc, nextState);
        }

        return nextState;
      },
    },
    view: (view) => {
      try {
        view.dispatch(view.state.tr.setMeta(pluginKey, { loaded: true }));
      } catch {
        // View might be destroyed during initialization.
      }
      return {};
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorationSet;
      },
      handleDOMEvents: {
        mouseup(view, event) {
          const target = event.target as HTMLElement;
          const diagram = target?.closest('.external-diagram-wrapper');
          const codeBlock = diagram?.previousElementSibling;

          if (!codeBlock) return false;

          const pos = view.posAtDOM(codeBlock, 0);
          if (!pos) return false;

          if (diagram && event.detail === 1) {
            view.dispatch(
              view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))),
            );
            return true;
          }

          return false;
        },
      },
    },
  });
}
