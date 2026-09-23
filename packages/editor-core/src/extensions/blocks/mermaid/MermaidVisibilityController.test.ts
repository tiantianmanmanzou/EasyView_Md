// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidVisibilityController } from "./MermaidVisibilityController";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("MermaidVisibilityController", () => {
  it("tracks the real editor scroll container instead of the webview viewport", async () => {
    const scrollRoot = document.createElement("div");
    scrollRoot.id = "editor-scroll-area";
    const targetElement = document.createElement("div");
    scrollRoot.appendChild(targetElement);
    document.body.appendChild(scrollRoot);

    let targetTop = 4000;
    scrollRoot.getBoundingClientRect = () =>
      ({ top: 100, bottom: 900, left: 0, right: 1200 }) as DOMRect;
    targetElement.getBoundingClientRect = () =>
      ({
        top: targetTop,
        bottom: targetTop + 120,
        left: 20,
        right: 1180,
      }) as DOMRect;

    const states: boolean[] = [];
    const controller = new MermaidVisibilityController(1200);
    controller.observe({
      element: targetElement,
      setViewportVisible: (visible) => states.push(visible),
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(states.at(-1)).toBe(false);

    targetTop = 500;
    scrollRoot.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(states.at(-1)).toBe(true);

    controller.dispose();
  });
});
