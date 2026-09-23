/**
 * Mermaid diagram rendering extension
 * Copied and adapted from Outline's shared/editor/extensions/Mermaid.ts
 */

import last from "lodash/last";
import sortBy from "lodash/sortBy";
import { v4 as uuidv4 } from "uuid";
import type MermaidUnsafe from "mermaid";
import type { Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { isCode, isMermaid } from "../../../editor/lib/CodeDetection";
import {
  findBlockNodes,
  type NodeWithPos,
  findParentNode,
} from "../../../editor/lib/NodeFinder";
import {
  MermaidRenderScheduler,
  MermaidSvgCache,
} from "./MermaidRenderScheduler";
import { withMermaidRuntimeLock } from "./MermaidRuntimeLock";
import { MermaidVisibilityController } from "./MermaidVisibilityController";

export const pluginKey = new PluginKey("mermaid");

export type MermaidOpenExternalLink = (href: string) => void;

export type MermaidState = {
  decorationSet: DecorationSet;
  isDark: boolean;
  editingId?: string;
};

let mermaid: typeof MermaidUnsafe;

const LIGHT_THEME_VARIABLES = {
  background: "#ffffff",
  mainBkg: "#f8fafc",
  secondBkg: "#eef6ff",
  tertiaryColor: "#f8fafc",
  primaryColor: "#f8fafc",
  primaryTextColor: "#1f2328",
  primaryBorderColor: "#8c959f",
  secondaryColor: "#eef6ff",
  secondaryTextColor: "#1f2328",
  secondaryBorderColor: "#8c959f",
  tertiaryTextColor: "#1f2328",
  tertiaryBorderColor: "#8c959f",
  nodeBorder: "#8c959f",
  clusterBkg: "#f6f8fa",
  clusterBorder: "#d0d7de",
  lineColor: "#8c959f",
  textColor: "#1f2328",
  edgeLabelBackground: "#ffffff",
  labelBackground: "#ffffff",
};

export class MermaidRenderer {
  readonly diagramId: string;
  readonly element: HTMLElement;
  readonly elementId: string;

  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private startTranslateX = 0;
  private startTranslateY = 0;
  private viewport: HTMLDivElement | null = null;
  private svgContainer: HTMLDivElement | null = null;
  private requestedBlock: { node: Node; pos: number } | null = null;
  private requestedDark = false;
  private requestedKey = "";
  private renderedKey = "";
  private pendingKey = "";
  private requestVersion = 0;
  private disposed = false;
  private visible = false;
  private retainedHeight = 120;

  constructor(
    private readonly scheduler: MermaidRenderScheduler,
    private readonly cache: MermaidSvgCache,
    private readonly visibility: MermaidVisibilityController,
    element?: HTMLElement,
    diagramId = uuidv4(),
  ) {
    this.diagramId = diagramId;
    this.elementId = `mermaid-diagram-wrapper-${this.diagramId}`;
    this.element = element ?? document.createElement("div");
    this.element.id = this.elementId;
    this.element.classList.add("mermaid-diagram-wrapper");
    this.showPlaceholder("Mermaid diagram");
  }

  mount(block: { node: Node; pos: number }, isDark: boolean): HTMLElement {
    if (this.disposed) return this.element;
    const nextKey = this.cacheKey(block.node.textContent, isDark);
    this.requestedBlock = block;
    this.requestedDark = isDark;
    if (this.requestedKey !== nextKey) {
      this.requestVersion++;
      this.scheduler.cancel(this);
      this.requestedKey = nextKey;
      this.renderedKey = "";
      this.pendingKey = "";
      this.releaseRenderedContent();
    }
    this.visibility.observe(this);
    if (this.visible) this.requestRender();
    return this.element;
  }

  requestRender(): void {
    if (this.disposed || !this.visible || !this.requestedBlock) return;
    const block = this.requestedBlock;
    const isDark = this.requestedDark;
    const key = this.cacheKey(block.node.textContent, isDark);
    if (this.renderedKey === key && this.element.querySelector("svg")) return;
    if (this.pendingKey === key) return;
    const version = ++this.requestVersion;
    this.pendingKey = key;
    this.scheduler.enqueue(this, async () => {
      try {
        await this.render(block, isDark, key, version);
      } finally {
        if (version === this.requestVersion) this.pendingKey = "";
      }
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestVersion++;
    this.pendingKey = "";
    this.scheduler.cancel(this);
    this.visibility.unobserve(this);
    this.requestedBlock = null;
    this.element.replaceChildren();
    this.viewport = null;
    this.svgContainer = null;
  }

  setViewportVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible) this.requestRender();
    else {
      this.requestVersion++;
      this.pendingKey = "";
      this.scheduler.cancel(this);
      this.releaseRenderedContent();
    }
  }

  private cacheKey(text: string, isDark: boolean): string {
    return `${isDark ? "dark" : "light"}-${text}`;
  }

  private showPlaceholder(label: string): void {
    this.element.replaceChildren();
    this.element.style.minHeight = `${this.retainedHeight}px`;
    const placeholder = document.createElement("div");
    placeholder.className = "mermaid-render-placeholder";
    placeholder.textContent = label;
    this.element.appendChild(placeholder);
    this.viewport = null;
    this.svgContainer = null;
  }

  private releaseRenderedContent(): void {
    if (this.element.isConnected) {
      const height = this.element.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0)
        this.retainedHeight = Math.max(120, Math.ceil(height));
    }
    this.showPlaceholder("Mermaid diagram");
  }

  private resetZoomPan(): void {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  private applyTransform(): void {
    if (this.svgContainer) {
      this.svgContainer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    }
  }

  private setupZoomPan(element: HTMLElement): void {
    const viewport = document.createElement("div");
    viewport.className = "mermaid-viewport";
    const svgContainer = document.createElement("div");
    svgContainer.className = "mermaid-svg-container";
    while (element.firstChild) svgContainer.appendChild(element.firstChild);
    viewport.appendChild(svgContainer);

    const controls = document.createElement("div");
    controls.className = "mermaid-zoom-controls";
    const zoomIn = document.createElement("button");
    zoomIn.className = "mermaid-zoom-btn";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom in";
    zoomIn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!this.viewport) return;
      const rect = this.viewport.getBoundingClientRect();
      const oldScale = this.scale;
      this.scale = Math.min(this.scale * 1.25, 5);
      this.translateX =
        rect.width / 2 -
        (rect.width / 2 - this.translateX) * (this.scale / oldScale);
      this.translateY =
        rect.height / 2 -
        (rect.height / 2 - this.translateY) * (this.scale / oldScale);
      this.applyTransform();
    });
    const zoomOut = document.createElement("button");
    zoomOut.className = "mermaid-zoom-btn";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom out";
    zoomOut.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!this.viewport) return;
      const rect = this.viewport.getBoundingClientRect();
      const oldScale = this.scale;
      this.scale = Math.max(this.scale / 1.25, 0.2);
      this.translateX =
        rect.width / 2 -
        (rect.width / 2 - this.translateX) * (this.scale / oldScale);
      this.translateY =
        rect.height / 2 -
        (rect.height / 2 - this.translateY) * (this.scale / oldScale);
      this.applyTransform();
    });
    const zoomReset = document.createElement("button");
    zoomReset.className = "mermaid-zoom-btn";
    zoomReset.textContent = "1:1";
    zoomReset.title = "Reset zoom";
    zoomReset.addEventListener("click", (event) => {
      event.stopPropagation();
      this.resetZoomPan();
    });
    controls.append(zoomOut, zoomReset, zoomIn);
    viewport.appendChild(controls);
    element.appendChild(viewport);
    this.viewport = viewport;
    this.svgContainer = svgContainer;

    viewport.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const oldScale = this.scale;
        this.scale = Math.min(
          Math.max(this.scale * (event.deltaY < 0 ? 1.1 : 0.9), 0.2),
          5,
        );
        this.translateX =
          mouseX - (mouseX - this.translateX) * (this.scale / oldScale);
        this.translateY =
          mouseY - (mouseY - this.translateY) * (this.scale / oldScale);
        this.applyTransform();
      },
      { passive: false },
    );
    viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.isPanning = true;
      this.panStartX = event.clientX;
      this.panStartY = event.clientY;
      this.startTranslateX = this.translateX;
      this.startTranslateY = this.translateY;
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("panning");
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!this.isPanning) return;
      this.translateX = this.startTranslateX + event.clientX - this.panStartX;
      this.translateY = this.startTranslateY + event.clientY - this.panStartY;
      this.applyTransform();
    });
    const endPan = (event: PointerEvent) => {
      if (!this.isPanning) return;
      this.isPanning = false;
      if (viewport.hasPointerCapture(event.pointerId))
        viewport.releasePointerCapture(event.pointerId);
      viewport.classList.remove("panning");
    };
    viewport.addEventListener("pointerup", endPan);
    viewport.addEventListener("pointercancel", endPan);
  }

  private async render(
    block: { node: Node; pos: number },
    isDark: boolean,
    key: string,
    version: number,
  ): Promise<void> {
    if (this.disposed || !this.visible || version !== this.requestVersion)
      return;
    const text = block.node.textContent;
    let svg = this.cache.get(key);
    let bindFunctions: ((element: Element) => void) | undefined;

    if (!svg) {
      const renderElement = document.createElement("div");
      const tempId = `offscreen-mermaid-${this.diagramId}-${version}`;
      renderElement.id = tempId;
      renderElement.style.cssText =
        "position:absolute;left:-9999px;top:-9999px;font-size:12px;";
      document.body.appendChild(renderElement);
      try {
        const rendered = await withMermaidRuntimeLock(async () => {
          mermaid ??= (await import("mermaid")).default;
          mermaid.initialize({
            startOnLoad: false,
            suppressErrorRendering: true,
            flowchart: { wrappingWidth: 320 },
            gantt: { useWidth: 700 },
            pie: { useWidth: 700 },
            fontSize: 12,
            theme: isDark ? "dark" : "base",
            darkMode: isDark,
            themeVariables: isDark ? undefined : LIGHT_THEME_VARIABLES,
          });
          return mermaid.render(tempId, text);
        });
        svg = rendered.svg;
        bindFunctions = rendered.bindFunctions;
        if (text && !this.disposed) this.cache.set(key, svg);
      } finally {
        renderElement.remove();
      }
    }

    if (
      this.disposed ||
      !this.visible ||
      version !== this.requestVersion ||
      !svg
    )
      return;
    this.element.classList.remove("parse-error", "empty");
    this.element.style.minHeight = "";
    this.element.replaceChildren();
    const template = document.createElement("template");
    template.innerHTML = svg;
    this.element.appendChild(template.content);
    this.resetZoomPan();
    this.setupZoomPan(this.element);
    bindFunctions?.(this.element);
    this.renderedKey = key;
  }
}

function overlap(
  start1: number,
  end1: number,
  start2: number,
  end2: number,
): number {
  return Math.max(0, Math.min(end1, end2) - Math.max(start1, start2));
}

/*
  This code find the decoration that overlap the most with a given node.
  This will ensure we can find the best decoration that match the last change set
  See: https://github.com/outline/outline/pull/5852/files#r1334929120
*/
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

function getNewState({
  doc,
  pluginState,
}: {
  doc: Node;
  pluginState: MermaidState;
}): MermaidState {
  const decorations: Decoration[] = [];

  // Find all blocks that represent Mermaid diagrams (supports both "mermaid" and "mermaidjs")
  const allBlocks = findBlockNodes(doc, true); // MUST use true to descend into document structure
  const codeBlocks = allBlocks.filter((item) => isCode(item.node));
  const blocks = codeBlocks.filter((item) => isMermaid(item.node));

  blocks.forEach((block) => {
    const existingDecorations = pluginState.decorationSet.find(
      block.pos,
      block.pos + block.node.nodeSize,
      (spec) => !!spec.diagramId,
    );

    const bestDecoration = findBestOverlapDecoration(
      existingDecorations,
      block,
    );

    const diagramId: string = bestDecoration?.spec.diagramId ?? uuidv4();
    // EditorState (including undo snapshots) contains identifiers only. A widget
    // never closes over a renderer, cache, scheduler or a historical document.
    const diagramDecoration = Decoration.widget(
      block.pos + block.node.nodeSize,
      () => {
        const element = document.createElement("div");
        element.id = `mermaid-diagram-wrapper-${diagramId}`;
        element.className = "mermaid-diagram-wrapper";
        element.style.minHeight = "120px";
        return element;
      },
      { diagramId, blockPos: block.pos, key: diagramId, side: -10 },
    );

    const diagramIdDecoration = Decoration.node(
      block.pos,
      block.pos + block.node.nodeSize,
      {},
      {
        diagramId,
      },
    );

    decorations.push(diagramDecoration);
    decorations.push(diagramIdDecoration);
  });

  return {
    ...pluginState,
    decorationSet: DecorationSet.create(doc, decorations),
  };
}

export default function Mermaid({
  isDark,
  openExternalLink,
}: {
  isDark: boolean;
  openExternalLink: MermaidOpenExternalLink;
}) {
  return new Plugin({
    key: pluginKey,
    state: {
      init: (_, { doc }) => {
        const pluginState: MermaidState = {
          decorationSet: DecorationSet.create(doc, []),
          isDark,
        };
        return getNewState({
          doc,
          pluginState,
        });
      },
      apply: (
        transaction: Transaction,
        pluginState: MermaidState,
        oldState,
        state,
      ) => {
        const themeMeta = transaction.getMeta("theme");
        const mermaidMeta = transaction.getMeta(pluginKey);
        const themeToggled = themeMeta?.isDark !== undefined;

        // During drag-drop, clear all decorations to prevent DOM reconciliation crashes
        if (mermaidMeta?.clearForDrop) {
          return {
            ...pluginState,
            editingId: undefined,
            decorationSet: DecorationSet.create(transaction.doc, []),
          };
        }

        const nextPluginState = {
          ...pluginState,
          isDark: themeToggled ? themeMeta.isDark : pluginState.isDark,
          editingId:
            mermaidMeta && "editingId" in mermaidMeta
              ? mermaidMeta.editingId
              : pluginState.editingId,
          decorationSet: pluginState.decorationSet.map(
            transaction.mapping,
            transaction.doc,
          ),
        };

        if (
          transaction.selectionSet &&
          nextPluginState.editingId &&
          !mermaidMeta
        ) {
          const codeBlock = findParentNode(isCode)(state.selection);
          let isEditing = codeBlock && isMermaid(codeBlock.node);

          if (isEditing && codeBlock && !transaction.docChanged) {
            const decorations = nextPluginState.decorationSet.find(
              codeBlock.pos,
              codeBlock.pos + codeBlock.node.nodeSize,
            );
            const nodeDecoration = decorations.find(
              (d) => d.spec.diagramId && d.from === codeBlock.pos,
            );
            if (nodeDecoration?.spec.diagramId !== nextPluginState.editingId) {
              isEditing = false;
            }
          }

          if (!isEditing) {
            nextPluginState.editingId = undefined;
          }
        }

        // @ts-expect-error accessing private field.
        const isPaste = transaction.meta?.paste;

        // Recalculate on any doc change, paste, or theme toggle
        if (isPaste || mermaidMeta || themeToggled || transaction.docChanged) {
          return getNewState({
            doc: transaction.doc,
            pluginState: nextPluginState,
          });
        }

        return nextPluginState;
      },
    },
    view: (view) => {
      // Plugin views may be recreated when EditorState is replaced. Each view
      // owns its runtime; the next view rehydrates the current widget DOM from
      // document state instead of reusing resources destroyed by the old view.
      const scheduler = new MermaidRenderScheduler();
      const cache = new MermaidSvgCache();
      const visibility = new MermaidVisibilityController();
      const renderers = new Map<string, MermaidRenderer>();
      const sync = () => {
        const state = pluginKey.getState(view.state) as MermaidState;
        const elements = new Map(
          Array.from(view.dom.querySelectorAll<HTMLElement>(".mermaid-diagram-wrapper"))
            .map((element) => [element.id, element] as const),
        );
        const liveIds = new Set<string>();
        for (const decoration of state.decorationSet.find()) {
          const blockPos = decoration.spec.blockPos as number | undefined;
          if (!decoration.spec.diagramId || blockPos === undefined) continue;
          const diagramId = decoration.spec.diagramId as string;
          const node = view.state.doc.nodeAt(blockPos);
          const element = elements.get(`mermaid-diagram-wrapper-${diagramId}`);
          if (!node || !element) continue;
          liveIds.add(diagramId);
          let renderer = renderers.get(diagramId);
          if (renderer && renderer.element !== element) {
            renderer.destroy();
            renderers.delete(diagramId);
            renderer = undefined;
          }
          if (!renderer) {
            renderer = new MermaidRenderer(scheduler, cache, visibility, element, diagramId);
            renderers.set(diagramId, renderer);
          }
          renderer.mount({ node, pos: blockPos }, state.isDark);
        }
        for (const [id, renderer] of renderers) {
          if (!liveIds.has(id)) {
            renderer.destroy();
            renderers.delete(id);
          }
        }
      };
      sync();
      return {
        update(_view, prevState) {
          const previous = pluginKey.getState(prevState) as MermaidState | undefined;
          const current = pluginKey.getState(view.state) as MermaidState;
          if (previous?.decorationSet !== current.decorationSet || previous?.isDark !== current.isDark) sync();
        },
        destroy() {
          visibility.dispose();
          scheduler.dispose();
          for (const renderer of renderers.values()) renderer.destroy();
          renderers.clear();
          cache.clear();
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorationSet;
      },
      handleDOMEvents: {
        click(_view, event: MouseEvent) {
          const target = event.target as HTMLElement;
          const anchor = target?.closest("a");

          if (anchor instanceof SVGAElement) {
            event.stopPropagation();
            event.preventDefault();
            return false;
          }

          return true;
        },
        mouseup(view, event) {
          const target = event.target as HTMLElement;
          const diagram = target?.closest(".mermaid-diagram-wrapper");
          const codeBlock = diagram?.previousElementSibling;

          if (!codeBlock) {
            return false;
          }

          const anchor = target?.closest("a");
          if (anchor instanceof SVGAElement) {
            const href = anchor.getAttribute("xlink:href");

            if (href) {
              event.stopPropagation();
              event.preventDefault();
              openExternalLink(href);
            }

            return false;
          }

          const pos = view.posAtDOM(codeBlock, 0);
          if (!pos) {
            return false;
          }

          if (diagram && event.detail === 1) {
            // Select node on single click
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(pos)),
              ),
            );
            return true;
          }

          return false;
        },
        keydown: (view, event) => {
          switch (event.key) {
            case "ArrowDown": {
              const { selection } = view.state;
              const $pos = view.state.doc.resolve(
                Math.min(selection.from + 1, view.state.doc.nodeSize),
              );
              const nextBlock = $pos.nodeAfter;

              if (nextBlock && isMermaid(nextBlock)) {
                view.dispatch(
                  view.state.tr
                    .setSelection(
                      TextSelection.near(
                        view.state.doc.resolve(selection.to + 1),
                      ),
                    )
                    .scrollIntoView(),
                );
                event.preventDefault();
                return true;
              }
              return false;
            }
            case "ArrowUp": {
              const { selection } = view.state;
              const $pos = view.state.doc.resolve(
                Math.max(0, selection.from - 1),
              );
              const prevBlock = $pos.nodeBefore;

              if (prevBlock && isMermaid(prevBlock)) {
                view.dispatch(
                  view.state.tr
                    .setSelection(
                      TextSelection.near(
                        view.state.doc.resolve(selection.from - 2),
                      ),
                    )
                    .scrollIntoView(),
                );
                event.preventDefault();
                return true;
              }
              return false;
            }
          }

          return false;
        },
      },
    },
  });
}
