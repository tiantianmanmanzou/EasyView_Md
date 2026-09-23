// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTemplate } from "./ExportTemplate";

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  delete (globalThis as { mermaid?: unknown }).mermaid;
});

describe("standalone HTML Mermaid export", () => {
  it("renders all diagrams serially", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const content = document.createElement("article");
    for (let index = 0; index < 68; index++) {
      const block = document.createElement("pre");
      block.className = "mermaid";
      block.setAttribute("data-source", `flowchart LR\nA${index}-->B${index}`);
      content.appendChild(block);
    }
    document.body.appendChild(content);

    let active = 0;
    let maxActive = 0;
    const render = vi.fn(async (_id: string, source: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      active--;
      return { svg: `<svg data-source="${source.split("\n")[1]}"></svg>` };
    });
    (globalThis as { mermaid?: unknown }).mermaid = {
      initialize: vi.fn(),
      render,
    };

    const html = buildTemplate(content.innerHTML, "", {
      title: "Mermaid export",
      isDark: false,
      hasMermaid: true,
      hasMath: false,
    });
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    Function(script!)();
    for (
      let attempt = 0;
      attempt < 300 && content.querySelectorAll("svg").length < 68;
      attempt++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }

    expect(render).toHaveBeenCalledTimes(68);
    expect(maxActive).toBe(1);
    expect(content.querySelectorAll("svg")).toHaveLength(68);
  });
});
