// Off-page continuation labels in the PDF export (#183 feature, #317 bug).
//
// The PDF path re-derives the pills the editor's PageBoundaryOverlay draws, and has to
// decide which of the two pills at a boundary belongs on THIS sheet. It bounded that
// decision against PageRect.contentH, which subtracts the title-block strip — but the
// page raster spans the full sheet inside the print margins and the pills are drawn on
// top of the title block, exactly as in the editor. The mismatch silently dropped every
// pill for a connection leaving the bottom of a page.

import { describe, expect, it } from "vitest";
import { computePdfCrossingLabels } from "../pdfExport";
import { computePageGrid } from "../printPageGrid";
import { getPaperSize, PAGE_MARGIN_IN } from "../printConfig";
import { layoutContinuationPill, titleBlockBandInches } from "../continuationPill";
import { createDefaultLayout } from "../titleBlockLayout";
import type { RoutedEdge } from "../edgeRouter";
import type { ConnectionEdge, SchematicNode } from "../types";

const LETTER = getPaperSize("letter");
const LAYOUT = createDefaultLayout();
const SCALE = 1;
const DPI = 96;

/** Two devices a page apart vertically — forces a 1-column × 2-row page grid. */
const topDevice = {
  id: "dev-rack-switch",
  type: "device",
  position: { x: 100, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Rack Switch", ports: [] },
} as unknown as SchematicNode;

const bottomDevice = {
  id: "dev-lobby-display",
  type: "device",
  position: { x: 100, y: 1200 },
  measured: { width: 144, height: 64 },
  data: { label: "Lobby Display", ports: [] },
} as unknown as SchematicNode;

/** Two devices side by side a page apart horizontally. */
const leftDevice = {
  id: "dev-left",
  type: "device",
  position: { x: 100, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Left Device", ports: [] },
} as unknown as SchematicNode;

const rightDevice = {
  id: "dev-right",
  type: "device",
  position: { x: 1000, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Right Device", ports: [] },
} as unknown as SchematicNode;

function edge(source: string, target: string): ConnectionEdge {
  return {
    id: "e1",
    source,
    target,
    data: { signalType: "ethernet" },
  } as unknown as ConnectionEdge;
}

function verticalRoute(x: number, y1: number, y2: number): RoutedEdge {
  return {
    segments: [{ x1: x, y1, x2: x, y2, axis: "v" }],
    waypoints: [{ x, y: y1 }, { x, y: y2 }],
    labelX: x,
    labelY: (y1 + y2) / 2,
  } as unknown as RoutedEdge;
}

function horizontalRoute(y: number, x1: number, x2: number): RoutedEdge {
  return {
    segments: [{ x1, y1: y, x2, y2: y, axis: "h" }],
    waypoints: [{ x: x1, y }, { x: x2, y }],
    labelX: (x1 + x2) / 2,
    labelY: y,
  } as unknown as RoutedEdge;
}

const pagesFor = (nodes: SchematicNode[]) =>
  computePageGrid(LETTER, "portrait", SCALE, nodes, 1.0, 0, 0);

describe("PDF off-page continuation labels — downward crossings (#317)", () => {
  const nodes = [topDevice, bottomDevice];
  const pages = pagesFor(nodes);
  const edges = [edge(topDevice.id, bottomDevice.id)];
  const routed = { e1: verticalRoute(150, 164, 1200) };

  it("splits the schematic across two stacked pages", () => {
    expect(pages.map((p) => p.row)).toEqual([0, 1]);
  });

  it("labels the wire leaving the BOTTOM of the upper page", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("up"); // pill sits above the boundary, arrow points down
    expect(labels[0].text).toBe("Lobby Display");
  });

  it("still labels the wire entering the TOP of the lower page", () => {
    const labels = computePdfCrossingLabels(pages[1], pages, routed, edges, nodes, SCALE);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("down");
    expect(labels[0].text).toBe("Rack Switch");
  });

  // The pill for a bottom exit lands in the strip the title block occupies. That strip is
  // still part of the rasterised page and the pill is drawn after the title block, so it
  // stays inside the sheet — this pins that it is on-page rather than clipped away.
  it("keeps the bottom pill inside the printed sheet", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    const pageHIn = LETTER.heightIn;
    expect(labels[0].y).toBeGreaterThan(PAGE_MARGIN_IN);
    expect(labels[0].y).toBeLessThan(pageHIn - PAGE_MARGIN_IN);
    // Below the top of the title block — the case the old contentH bound rejected.
    const titleBlockTopIn = pageHIn - PAGE_MARGIN_IN - 1.0;
    expect(labels[0].y).toBeGreaterThan(titleBlockTopIn);
  });

  it("places the pill an inset inside the page's bottom margin", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    const marginPx = pages[0].contentX - pages[0].x;
    const expectedPx = pages[0].y + pages[0].heightPx - marginPx - marginPx * 0.15;
    const expectedIn = PAGE_MARGIN_IN + (expectedPx - pages[0].contentY) * SCALE / DPI;
    expect(labels[0].y).toBeCloseTo(expectedIn, 6);
  });
});

describe("PDF off-page continuation labels — sideways crossings stay put", () => {
  const nodes = [leftDevice, rightDevice];
  const pages = pagesFor(nodes);
  const edges = [edge(leftDevice.id, rightDevice.id)];
  const routed = { e1: horizontalRoute(130, 244, 1000) };

  it("splits the schematic across two side-by-side pages", () => {
    expect(pages.map((p) => p.col)).toEqual([0, 1]);
  });

  it("labels both sides of a left/right boundary", () => {
    const first = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(first).toHaveLength(1);
    expect(first[0].anchor).toBe("left");
    expect(first[0].text).toBe("Right Device");

    const second = computePdfCrossingLabels(pages[1], pages, routed, edges, nodes, SCALE);
    expect(second).toHaveLength(1);
    expect(second[0].anchor).toBe("right");
    expect(second[0].text).toBe("Left Device");
  });
});

// Restoring the bottom pill (#317) put it back where the title block is drawn: an
// inset inside the page's bottom margin, which is inside the block's strip. The pill
// is opaque white, so on a connection running down the right-hand side of the sheet it
// wiped the block out. drawCrossingLabels now runs every pill through the shared
// clamp before drawing it.
describe("PDF off-page continuation labels — clear of the title block (#337)", () => {
  const BAND = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!;
  // What drawCrossingLabels measures for a pill: 6pt text plus 0.02in padding a side.
  const PILL_H = 6 / 72 + 0.04;
  const PILL_W = 1.1;

  /** A device column that lands under the title block, and its partner a page below. */
  const rightTop = { ...topDevice, position: { x: 540, y: 100 } } as SchematicNode;
  const rightBottom = { ...bottomDevice, position: { x: 540, y: 1200 } } as SchematicNode;

  const nodes = [rightTop, rightBottom];
  const pages = pagesFor(nodes);
  const edges = [edge(rightTop.id, rightBottom.id)];
  const routed = { e1: verticalRoute(590, 164, 1200) };

  it("anchors the bottom pill inside the title-block strip", () => {
    const labels = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    expect(labels).toHaveLength(1);
    expect(labels[0].anchor).toBe("up");
    expect(labels[0].x).toBeGreaterThan(BAND.x);
    expect(labels[0].y).toBeGreaterThan(BAND.y);
  });

  it("lifts that pill onto the top edge of the block instead of covering it", () => {
    const [label] = computePdfCrossingLabels(pages[0], pages, routed, edges, nodes, SCALE);
    const box = layoutContinuationPill(
      { anchor: label.anchor, x: label.x, y: label.y, width: PILL_W, height: PILL_H },
      [BAND],
    );
    expect(box.y + box.height).toBeCloseTo(BAND.y, 6);
    expect(box.y).toBeGreaterThan(PAGE_MARGIN_IN);
  });

  it("leaves a bottom pill out at the left-hand side of the sheet where it is", () => {
    const leftNodes = [topDevice, bottomDevice];
    const leftPages = pagesFor(leftNodes);
    const leftEdges = [edge(topDevice.id, bottomDevice.id)];
    const [label] = computePdfCrossingLabels(
      leftPages[0], leftPages, { e1: verticalRoute(150, 164, 1200) }, leftEdges, leftNodes, SCALE,
    );
    const box = layoutContinuationPill(
      { anchor: label.anchor, x: label.x, y: label.y, width: PILL_W, height: PILL_H },
      [BAND],
    );
    expect(box.y).toBeCloseTo(label.y - PILL_H, 6);
    expect(box.y).toBeGreaterThan(BAND.y);
  });
});
