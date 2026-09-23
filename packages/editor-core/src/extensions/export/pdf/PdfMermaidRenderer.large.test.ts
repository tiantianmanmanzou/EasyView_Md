// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMermaidSvgs } from "./PdfMermaidRenderer";
import { LIGHT_PALETTE } from "./PdfPalette";

describe("large Mermaid export", () => {
  it("renders every diagram through the PDF and DOCX export renderer", async () => {
    const sources = Array.from(
      { length: 68 },
      (_, index) =>
        `flowchart LR\n  A${index}[Start ${index}] --> B${index}[End ${index}]`,
    );

    const rendered = await renderMermaidSvgs(sources, LIGHT_PALETTE);

    expect(rendered.size).toBe(68);
    for (const source of sources) {
      expect(rendered.has(source)).toBe(true);
    }
  }, 30_000);
});
