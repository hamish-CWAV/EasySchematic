// Continuation pills must read the same text on screen and in the PDF (#294),
// and since #357 spreads pills by their measured width, differing text would
// also move them — a placement divergence, not just a cosmetic one. Both
// surfaces build their nodeId → label lookup from the case-transformed label;
// this pins that neither side quietly goes back to the raw one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function slice(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start === -1 || end === -1) throw new Error(`slice markers not found: ${from} … ${to}`);
  return src.slice(start, end);
}

describe("continuation pill label case parity (#294/#357)", () => {
  it("case-transforms the editor overlay's pill labels", () => {
    const src = read("../components/PageBoundaryOverlay.tsx");
    const lookup = slice(src, "// Build lookup: nodeId", "// Build edge lookup");
    // Device label and room label both go through the display-case transform.
    expect(lookup.match(/transformLabel\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(lookup).not.toMatch(/label:\s*data\.label\b/);
  });

  it("case-transforms the PDF's pill labels the same way", () => {
    const src = read("../pdfExport.ts");
    const lookup = slice(src, "const nodeInfo = new Map", "const hiddenAdapterIds");
    expect(lookup.match(/transformLabelNow\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
