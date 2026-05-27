import * as plantumlEncoder from 'plantuml-encoder';
import last from 'lodash/last';
import sortBy from 'lodash/sortBy';
import { v4 as uuidv4 } from 'uuid';
import type { Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { isCode, isPlantUml } from '../../../editor/lib/CodeDetection';
import { findBlockNodes, type NodeWithPos } from '../../../editor/lib/NodeFinder';

export const pluginKey = new PluginKey('plantuml');

type PlantUmlState = {
  decorationSet: DecorationSet;
};

const PLANTUML_SERVER = 'https://www.plantuml.com/plantuml/svg/';

class Cache {
  static get(key: string) {
    return this.data.get(key);
  }

  static set(key: string, value: string) {
    this.data.set(key, value);

    if (this.data.size > this.maxSize) {
      this.data.delete(this.data.keys().next().value);
    }
  }

  private static maxSize = 20;
  private static data = new Map<string, string>();
}

class PlantUmlRenderer {
  readonly diagramId: string;
  readonly element: HTMLElement;
  readonly elementId: string;

  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  private viewport: HTMLDivElement | null = null;
  private imageContainer: HTMLDivElement | null = null;

  constructor() {
    this.diagramId = uuidv4();
    this.elementId = `plantuml-diagram-wrapper-${this.diagramId}`;
    this.element =
      document.getElementById(this.elementId) || document.createElement('div');
    this.element.id = this.elementId;
    this.element.classList.add('mermaid-diagram-wrapper', 'plantuml-diagram-wrapper');
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
    viewport.className = 'mermaid-viewport plantuml-viewport';

    const imageContainer = document.createElement('div');
    imageContainer.className = 'mermaid-svg-container plantuml-image-container';

    while (element.firstChild) {
      imageContainer.appendChild(element.firstChild);
    }
    viewport.appendChild(imageContainer);

    const controls = document.createElement('div');
    controls.className = 'mermaid-zoom-controls plantuml-zoom-controls';

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
    zoomOut.textContent = '−';
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
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
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
    const rawSource = normalizePlantUmlSource(block.node.textContent);

    if (!rawSource.trim()) {
      this.element.classList.add('empty');
      this.element.classList.remove('parse-error');
      this.element.textContent = 'Empty PlantUML diagram';
      return;
    }

    const cachedUrl = Cache.get(rawSource);
    const url = cachedUrl ?? `${PLANTUML_SERVER}${plantumlEncoder.encode(rawSource)}`;
    if (!cachedUrl) {
      Cache.set(rawSource, url);
    }

    this.element.classList.remove('empty', 'parse-error');
    this.element.innerHTML = '';

    const image = document.createElement('img');
    image.src = url;
    image.alt = 'PlantUML diagram';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.draggable = false;
    image.className = 'plantuml-diagram-image';
    image.addEventListener('error', () => {
      this.element.classList.add('parse-error');
      this.element.textContent = 'Failed to render PlantUML diagram';
    }, { once: true });

    this.element.appendChild(image);
    this.resetZoomPan();
    this.setupZoomPan(this.element);
  }
}

function normalizePlantUmlSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return '';
  if (/^@start[\w-]+/i.test(trimmed)) {
    return trimmed;
  }
  return `@startuml\n${trimmed}\n@enduml`;
}

function overlap(start1: number, end1: number, start2: number, end2: number): number {
  return Math.max(0, Math.min(end1, end2) - Math.max(start1, start2));
}

function findBestOverlapDecoration(
  decorations: Decoration[],
  block: NodeWithPos,
): Decoration | undefined {
  if (decorations.length === 0) {
    return undefined;
  }
  return last(
    sortBy(decorations, (decoration) =>
      overlap(
        decoration.from,
        decoration.to,
        block.pos,
        block.pos + block.node.nodeSize,
      ),
    ),
  );
}

function getNewState(doc: Node, pluginState: PlantUmlState): PlantUmlState {
  const decorations: Decoration[] = [];
  const allBlocks = findBlockNodes(doc, true);
  const blocks = allBlocks.filter((item) => isCode(item.node) && isPlantUml(item.node));

  blocks.forEach((block) => {
    const existingDecorations = pluginState.decorationSet.find(
      block.pos,
      block.pos + block.node.nodeSize,
      (spec) => !!spec.diagramId,
    );
    const bestDecoration = findBestOverlapDecoration(existingDecorations, block);
    const renderer: PlantUmlRenderer =
      bestDecoration?.spec?.renderer ?? new PlantUmlRenderer();

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
    decorationSet: DecorationSet.create(doc, decorations),
  };
}

export default function PlantUmlPlugin() {
  return new Plugin({
    key: pluginKey,
    state: {
      init: (_, { doc }) => getNewState(doc, { decorationSet: DecorationSet.create(doc, []) }),
      apply(transaction: Transaction, pluginState: PlantUmlState) {
        const nextState = {
          decorationSet: pluginState.decorationSet.map(transaction.mapping, transaction.doc),
        };

        if (transaction.docChanged) {
          return getNewState(transaction.doc, nextState);
        }

        return nextState;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorationSet;
      },
      handleDOMEvents: {
        mouseup(view, event) {
          const target = event.target as HTMLElement;
          const diagram = target?.closest('.plantuml-diagram-wrapper');
          const codeBlock = diagram?.previousElementSibling;

          if (!codeBlock) {
            return false;
          }

          const pos = view.posAtDOM(codeBlock, 0);
          if (!pos) {
            return false;
          }

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
