// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node } from "prosemirror-model";
import { MermaidRenderer } from "./MermaidPlugin";
import {
  MermaidRenderScheduler,
  MermaidSvgCache,
} from "./MermaidRenderScheduler";
import { MermaidVisibilityController } from "./MermaidVisibilityController";

const initialize = vi.fn();
const render = vi.fn(async (_id: string, source: string) => ({
  svg: `<svg data-source="${source.replace(/"/g, "&quot;")}"></svg>`,
}));

vi.mock("mermaid", () => ({ default: { initialize, render } }));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not reached");
};

afterEach(() => {
  document.body.replaceChildren();
  initialize.mockClear();
  render.mockClear();
});

describe("MermaidRenderer large-document lifecycle", () => {
  it("defers offscreen diagrams and releases their SVG DOM after scrolling away", async () => {
    const scheduler = new MermaidRenderScheduler();
    const cache = new MermaidSvgCache();
    const visibility = new MermaidVisibilityController();
    const renderer = new MermaidRenderer(scheduler, cache, visibility);
    const scrollRoot = document.createElement("div");
    scrollRoot.id = "editor-scroll-area";
    scrollRoot.getBoundingClientRect = () =>
      ({ top: 0, bottom: 800, left: 0, right: 1200 }) as DOMRect;
    renderer.element.getBoundingClientRect = () =>
      ({ top: 3000, bottom: 3120, left: 0, right: 1200 }) as DOMRect;
    scrollRoot.appendChild(
      renderer.mount(
        {
          node: { textContent: "flowchart LR\nA-->B" } as Node,
          pos: 1,
        },
        false,
      ),
    );
    document.body.appendChild(scrollRoot);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    expect(render).not.toHaveBeenCalled();
    expect(renderer.element.querySelector("svg")).toBeNull();

    renderer.element.getBoundingClientRect = () =>
      ({ top: 400, bottom: 520, left: 0, right: 1200 }) as DOMRect;
    scrollRoot.dispatchEvent(new Event("scroll"));
    await waitFor(() => renderer.element.querySelector("svg") !== null);
    expect(render).toHaveBeenCalledTimes(1);

    renderer.element.getBoundingClientRect = () =>
      ({ top: 3000, bottom: 3120, left: 0, right: 1200 }) as DOMRect;
    scrollRoot.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(renderer.element.querySelector("svg")).toBeNull();
    expect(renderer.element.textContent).toContain("Mermaid diagram");

    renderer.element.getBoundingClientRect = () =>
      ({ top: 400, bottom: 520, left: 0, right: 1200 }) as DOMRect;
    scrollRoot.dispatchEvent(new Event("scroll"));
    await waitFor(() => renderer.element.querySelector("svg") !== null);
    expect(render).toHaveBeenCalledTimes(1);

    renderer.destroy();
    visibility.dispose();
    scheduler.dispose();
  });
});
