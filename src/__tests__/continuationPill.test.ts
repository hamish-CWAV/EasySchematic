// Shared placement + title-block clamp for the off-page continuation pills (#337).
//
// The pill is an opaque white chip. When a connection leaves the BOTTOM of a page the
// pill lands a print-margin inside the sheet edge — which is inside the strip the title
// block occupies — and whites the block out. The editor overlay and the PDF exporter
// both draw the pill, so the clamp lives in one place and both call it; these tests pin
// the geometry and the parity between the two surfaces' idea of where the block is.

import { describe, expect, it } from "vitest";
import {
  clampPillAboveBand,
  layoutContinuationPill,
  titleBlockBandInches,
  titleBlockBandPx,
  type TitleBlockBand,
} from "../continuationPill";
import { computePageGrid } from "../printPageGrid";
import { getPaperSize, PAGE_MARGIN_IN } from "../printConfig";
import { createDefaultLayout } from "../titleBlockLayout";
import type { SchematicNode } from "../types";

const LETTER = getPaperSize("letter");
const SCALE = 1;
const DPI = 96;
const LAYOUT = createDefaultLayout();

/** Two devices a page apart vertically — forces a 1-column × 2-row page grid. */
const upperDevice = {
  id: "dev-rack-switch",
  type: "device",
  position: { x: 550, y: 100 },
  measured: { width: 144, height: 64 },
  data: { label: "Rack Switch", ports: [] },
} as unknown as SchematicNode;

const lowerDevice = {
  id: "dev-lobby-display",
  type: "device",
  position: { x: 550, y: 1200 },
  measured: { width: 144, height: 64 },
  data: { label: "Lobby Display", ports: [] },
} as unknown as SchematicNode;

const pages = computePageGrid(LETTER, "portrait", SCALE, [upperDevice, lowerDevice], LAYOUT.heightIn, 0, 0);

describe("title-block band", () => {
  it("puts the band on the bottom margin, flush with the right-hand drawing border", () => {
    const band = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!;
    expect(band.width).toBeCloseTo(3.0, 6);
    expect(band.height).toBeCloseTo(1.0, 6);
    expect(band.x + band.width).toBeCloseTo(LETTER.widthIn - PAGE_MARGIN_IN, 6);
    expect(band.y + band.height).toBeCloseTo(LETTER.heightIn - PAGE_MARGIN_IN, 6);
  });

  it("caps the band at the drawing width when the layout is wider than the sheet", () => {
    const band = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, 99, 1.0)!;
    expect(band.width).toBeCloseTo(LETTER.widthIn - 2 * PAGE_MARGIN_IN, 6);
    expect(band.x).toBeCloseTo(PAGE_MARGIN_IN, 6);
  });

  it("reports no band when the title block has no height", () => {
    expect(titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, 3.0, 0)).toBeNull();
    expect(titleBlockBandPx(pages[0], 3.0, 0)).toBeNull();
  });

  it("lands the canvas-pixel band exactly where the overlay draws the block", () => {
    const page = pages[0];
    const band = titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!;
    // The overlay's own derivation: block top is the bottom of the printable content
    // area, and it is right-aligned inside the drawing border.
    expect(band.y).toBeCloseTo(page.contentY + page.contentH, 6);
    expect(band.y + band.height).toBeCloseTo(page.y + page.heightPx - (page.contentX - page.x), 6);
    expect(band.x + band.width).toBeCloseTo(page.contentX + page.contentW, 6);
  });

  it("agrees between the editor's canvas pixels and the exporter's page inches", () => {
    const page = pages[0];
    const px = titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!;
    const inches = titleBlockBandInches(LETTER.widthIn, LETTER.heightIn, LAYOUT.widthIn, LAYOUT.heightIn)!;
    // Same transform the PDF path uses to move a canvas point onto the sheet
    const toPageX = (cx: number) => PAGE_MARGIN_IN + (cx - page.contentX) * SCALE / DPI;
    const toPageY = (cy: number) => PAGE_MARGIN_IN + (cy - page.contentY) * SCALE / DPI;
    expect(toPageX(px.x)).toBeCloseTo(inches.x, 6);
    expect(toPageY(px.y)).toBeCloseTo(inches.y, 6);
    expect(px.width * SCALE / DPI).toBeCloseTo(inches.width, 6);
    expect(px.height * SCALE / DPI).toBeCloseTo(inches.height, 6);
  });
});

describe("clamping a continuation pill off the title block", () => {
  const band: TitleBlockBand = { x: 5.1, y: 9.6, width: 3.0, height: 1.0 };

  it("lifts a pill that has landed on the band up onto its top edge", () => {
    const box = clampPillAboveBand({ x: 6.0, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(band.y - 0.12, 6);
    expect(box.y + box.height).toBeCloseTo(band.y, 6);
    expect(box.x).toBeCloseTo(6.0, 6); // horizontal placement is untouched
  });

  it("leaves a pill that clears the band vertically alone", () => {
    const box = clampPillAboveBand({ x: 6.0, y: 4.0, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(4.0, 6);
  });

  it("leaves a pill alone when the band spans only part of the sheet width", () => {
    // Same vertical position, but out at the left-hand side where no block is drawn
    const box = clampPillAboveBand({ x: 0.5, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(10.3, 6);
  });

  it("leaves a pill resting exactly on the band's top edge alone", () => {
    const box = clampPillAboveBand({ x: 6.0, y: band.y - 0.12, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(band.y - 0.12, 6);
  });

  it("leaves a pill touching the band's right edge alone", () => {
    const box = clampPillAboveBand({ x: band.x - 1.2, y: 10.3, width: 1.2, height: 0.12 }, band);
    expect(box.y).toBeCloseTo(10.3, 6);
  });

  it("does nothing when the sheet has no title block", () => {
    const box = clampPillAboveBand({ x: 6.0, y: 10.3, width: 1.2, height: 0.12 }, null);
    expect(box.y).toBeCloseTo(10.3, 6);
  });
});

describe("placing a continuation pill", () => {
  const noBands: TitleBlockBand[] = [];

  it("grows the box inward from the boundary for each anchor", () => {
    const size = { width: 1.0, height: 0.2 };
    expect(layoutContinuationPill({ anchor: "left", x: 4, y: 3, ...size }, noBands))
      .toMatchObject({ x: 3, y: 2.9 });
    expect(layoutContinuationPill({ anchor: "right", x: 4, y: 3, ...size }, noBands))
      .toMatchObject({ x: 4, y: 2.9 });
    expect(layoutContinuationPill({ anchor: "up", x: 4, y: 3, ...size }, noBands))
      .toMatchObject({ x: 3.5, y: 2.8 });
    expect(layoutContinuationPill({ anchor: "down", x: 4, y: 3, ...size }, noBands))
      .toMatchObject({ x: 3.5, y: 3 });
  });

  it("keeps a bottom-exit pill off the block it would otherwise white out", () => {
    const page = pages[0];
    const band = titleBlockBandPx(page, LAYOUT.widthIn, LAYOUT.heightIn)!;
    const marginPx = page.contentX - page.x;
    // Where the overlay anchors an "up" pill: an inset inside the page's bottom margin,
    // on a connection running down the right-hand side of the sheet.
    const anchorY = page.y + page.heightPx - marginPx - marginPx * 0.15;
    const anchorX = band.x + band.width / 2;
    const boxH = 12;

    const unclamped = layoutContinuationPill({ anchor: "up", x: anchorX, y: anchorY, width: 90, height: boxH }, []);
    expect(unclamped.y).toBeGreaterThan(band.y);

    const box = layoutContinuationPill({ anchor: "up", x: anchorX, y: anchorY, width: 90, height: boxH }, [band]);
    expect(box.y + box.height).toBeCloseTo(band.y, 6);
    expect(box.y).toBeGreaterThan(page.contentY); // still inside the drawing border
  });
});
