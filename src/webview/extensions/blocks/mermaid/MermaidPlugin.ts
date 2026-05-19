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
import { findBlockNodes, type NodeWithPos, findParentNode } from "../../../editor/lib/NodeFinder";

export const pluginKey = new PluginKey("mermaid");

export type MermaidState = {
  decorationSet: DecorationSet;
  isDark: boolean;
  editingId?: string;
};

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
  private static data: Map<string, string> = new Map();
}

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

class MermaidRenderer {
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

  constructor() {
    this.diagramId = uuidv4();
    this.elementId = `mermaid-diagram-wrapper-${this.diagramId}`;
    this.element =
      document.getElementById(this.elementId) || document.createElement("div");
    this.element.id = this.elementId;
    this.element.classList.add("mermaid-diagram-wrapper");
  }

  private resetZoomPan() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  private applyTransform() {
    if (this.svgContainer) {
      this.svgContainer.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    }
  }

  private setupZoomPan(element: HTMLElement) {
    // Build zoom/pan structure
    const viewport = document.createElement("div");
    viewport.className = "mermaid-viewport";

    const svgContainer = document.createElement("div");
    svgContainer.className = "mermaid-svg-container";

    // Move existing SVG content into container
    while (element.firstChild) {
      svgContainer.appendChild(element.firstChild);
    }
    viewport.appendChild(svgContainer);

    // Zoom controls
    const controls = document.createElement("div");
    controls.className = "mermaid-zoom-controls";

    const zoomIn = document.createElement("button");
    zoomIn.className = "mermaid-zoom-btn";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom in";
    zoomIn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.viewport) return;
      const rect = this.viewport.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const oldScale = this.scale;
      this.scale = Math.min(this.scale * 1.25, 5);
      this.translateX = cx - (cx - this.translateX) * (this.scale / oldScale);
      this.translateY = cy - (cy - this.translateY) * (this.scale / oldScale);
      this.applyTransform();
    });

    const zoomOut = document.createElement("button");
    zoomOut.className = "mermaid-zoom-btn";
    zoomOut.textContent = "\u2212"; // minus sign
    zoomOut.title = "Zoom out";
    zoomOut.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.viewport) return;
      const rect = this.viewport.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const oldScale = this.scale;
      this.scale = Math.max(this.scale / 1.25, 0.2);
      this.translateX = cx - (cx - this.translateX) * (this.scale / oldScale);
      this.translateY = cy - (cy - this.translateY) * (this.scale / oldScale);
      this.applyTransform();
    });

    const zoomReset = document.createElement("button");
    zoomReset.className = "mermaid-zoom-btn";
    zoomReset.textContent = "1:1";
    zoomReset.title = "Reset zoom";
    zoomReset.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resetZoomPan();
    });

    controls.appendChild(zoomIn);
    controls.appendChild(zoomOut);
    controls.appendChild(zoomReset);

    element.appendChild(viewport);
    element.appendChild(controls);

    this.viewport = viewport;
    this.svgContainer = svgContainer;

    // Wheel zoom only with an explicit modifier. Plain touchpad/mouse-wheel
    // scrolling should keep scrolling the document when the cursor is over a diagram.
    viewport.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const oldScale = this.scale;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.scale = Math.min(Math.max(this.scale * factor, 0.2), 5);
      // Adjust translation so point under mouse stays fixed
      this.translateX = mouseX - (mouseX - this.translateX) * (this.scale / oldScale);
      this.translateY = mouseY - (mouseY - this.translateY) * (this.scale / oldScale);
      this.applyTransform();
    }, { passive: false });

    // Pan via pointer events
    viewport.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.startTranslateX = this.translateX;
      this.startTranslateY = this.translateY;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("panning");
    });

    viewport.addEventListener("pointermove", (e) => {
      if (!this.isPanning) return;
      this.translateX = this.startTranslateX + (e.clientX - this.panStartX);
      this.translateY = this.startTranslateY + (e.clientY - this.panStartY);
      this.applyTransform();
    });

    const endPan = (e: PointerEvent) => {
      if (!this.isPanning) return;
      this.isPanning = false;
      viewport.releasePointerCapture(e.pointerId);
      viewport.classList.remove("panning");
    };
    viewport.addEventListener("pointerup", endPan);
    viewport.addEventListener("pointercancel", endPan);
  }

  render = async (block: { node: Node; pos: number }, isDark: boolean) => {
    const element = this.element;
    const text = block.node.textContent;

    const cacheKey = `${isDark ? "dark" : "light"}-${text}`;
    const cache = Cache.get(cacheKey);
    if (cache) {
      element.classList.remove("parse-error", "empty");
      element.innerHTML = "";
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = cache;
      while (tempDiv.firstChild) {
        element.appendChild(tempDiv.firstChild);
      }
      this.resetZoomPan();
      this.setupZoomPan(element);
      return;
    }

    // Create a temporary element that will render the diagram off-screen. This is necessary
    // as Mermaid will error if the element is not visible or the element is removed while the
    // diagram is being rendered.
    const renderElement = document.createElement("div");
    const tempId =
      "offscreen-mermaid-" + Math.random().toString(36).substr(2, 9);
    renderElement.id = tempId;
    renderElement.style.position = "absolute";
    renderElement.style.left = "-9999px";
    renderElement.style.top = "-9999px";
    renderElement.style.fontSize = "12px";
    document.body.appendChild(renderElement);

    try {
      mermaid ??= (await import("mermaid")).default;

      mermaid.initialize({
        startOnLoad: true,
        suppressErrorRendering: true,
        gantt: { useWidth: 700 },
        pie: { useWidth: 700 },
        fontSize: 12,
        theme: isDark ? "dark" : "base",
        darkMode: isDark,
        themeVariables: isDark ? undefined : LIGHT_THEME_VARIABLES,
      });

      const { svg, bindFunctions } = await mermaid.render(tempId, text);

      // Cache the rendered SVG so we won't need to calculate it again in the same session
      if (text) {
        Cache.set(cacheKey, svg);
      }
      element.classList.remove("parse-error", "empty");
      element.innerHTML = "";
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = svg;
      while (tempDiv.firstChild) {
        element.appendChild(tempDiv.firstChild);
      }

      // Setup zoom/pan controls
      this.resetZoomPan();
      this.setupZoomPan(element);

      // Allow the user to interact with the diagram
      bindFunctions?.(element);
    } catch (error) {
      const isEmpty = block.node.textContent.trim().length === 0;

      if (isEmpty) {
        element.innerText = "Empty diagram";
        element.classList.add("empty");
      } else {
        element.innerText = String(error);
        element.classList.add("parse-error");
      }
    } finally {
      renderElement.remove();
    }
  };
}

function overlap(
  start1: number,
  end1: number,
  start2: number,
  end2: number
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
  block: NodeWithPos
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
        block.pos + block.node.nodeSize
      )
    )
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
  const allBlocks = findBlockNodes(doc, true);  // MUST use true to descend into document structure
  const codeBlocks = allBlocks.filter((item) => isCode(item.node));
  const blocks = codeBlocks.filter((item) => isMermaid(item.node));

  blocks.forEach((block, index) => {
    const existingDecorations = pluginState.decorationSet.find(
      block.pos,
      block.pos + block.node.nodeSize,
      (spec) => !!spec.diagramId
    );

    const bestDecoration = findBestOverlapDecoration(
      existingDecorations,
      block
    );

    const renderer: MermaidRenderer =
      bestDecoration?.spec?.renderer ?? new MermaidRenderer();

    const diagramDecoration = Decoration.widget(
      block.pos + block.node.nodeSize,
      () => {
        void renderer.render(block, pluginState.isDark);
        return renderer.element;
      },
      {
        diagramId: renderer.diagramId,
        renderer,
        side: -10,
      }
    );

    const diagramIdDecoration = Decoration.node(
      block.pos,
      block.pos + block.node.nodeSize,
      {},
      {
        diagramId: renderer.diagramId,
        renderer,
      }
    );

    decorations.push(diagramDecoration);
    decorations.push(diagramIdDecoration);
  });

  return {
    ...pluginState,
    decorationSet: DecorationSet.create(doc, decorations),
  };
}

export default function Mermaid({ isDark }: { isDark: boolean }) {
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
        state
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
            transaction.doc
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
              codeBlock.pos + codeBlock.node.nodeSize
            );
            const nodeDecoration = decorations.find(
              (d) => d.spec.diagramId && d.from === codeBlock.pos
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
      try {
        view.dispatch(view.state.tr.setMeta(pluginKey, { loaded: true }));
      } catch (e) {
        // View might be destroyed
      }
      return {
        update(view, prevState) {
          const prevPluginState = pluginKey.getState(prevState);
          const pluginState = pluginKey.getState(view.state);
          if (!prevPluginState || !pluginState || prevPluginState.isDark === pluginState.isDark) {
            return;
          }

          const allBlocks = findBlockNodes(view.state.doc, true);
          const mermaidBlocks = allBlocks.filter((item) => isCode(item.node) && isMermaid(item.node));
          for (const block of mermaidBlocks) {
            const decorations = pluginState.decorationSet.find(
              block.pos,
              block.pos + block.node.nodeSize,
              (spec) => !!spec.renderer
            );
            const renderer = decorations.find((decoration) => decoration.spec.renderer)?.spec.renderer as MermaidRenderer | undefined;
            if (renderer) {
              void renderer.render(block, pluginState.isDark);
            }
          }
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
              // In VS Code webview, open external links
              // @ts-expect-error VS Code API
              if (typeof acquireVsCodeApi !== "undefined") {
                // @ts-expect-error VS Code API
                const vscode = acquireVsCodeApi();
                vscode.postMessage({
                  type: "openLink",
                  href: href,
                });
              }
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
              view.state.tr
                .setSelection(TextSelection.near(view.state.doc.resolve(pos)))
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
                Math.min(selection.from + 1, view.state.doc.nodeSize)
              );
              const nextBlock = $pos.nodeAfter;

              if (nextBlock && isMermaid(nextBlock)) {
                view.dispatch(
                  view.state.tr
                    .setSelection(
                      TextSelection.near(
                        view.state.doc.resolve(selection.to + 1)
                      )
                    )
                    .scrollIntoView()
                );
                event.preventDefault();
                return true;
              }
              return false;
            }
            case "ArrowUp": {
              const { selection } = view.state;
              const $pos = view.state.doc.resolve(
                Math.max(0, selection.from - 1)
              );
              const prevBlock = $pos.nodeBefore;

              if (prevBlock && isMermaid(prevBlock)) {
                view.dispatch(
                  view.state.tr
                    .setSelection(
                      TextSelection.near(
                        view.state.doc.resolve(selection.from - 2)
                      )
                    )
                    .scrollIntoView()
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
