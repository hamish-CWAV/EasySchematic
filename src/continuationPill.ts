// Shared geometry for the off-page continuation pills (#183, #317, #337).
//
// The editor overlay draws these on the canvas and the PDF exporter redraws them on
// the sheet. Each surface used to carry its own copy of the box placement, so a fix
// applied to one could silently disagree with the other. Both now go through
// layoutContinuationPill, which places the box AND keeps it clear of the title block.

import { PAGE_MARGIN_IN } from "./printConfig";
import type { PageRect } from "./printPageGrid";

/** Which way the pill grows from its crossing point. */
export type PillAnchor = "left" | "right" | "up" | "down";

export interface PillRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle the title block occupies, in the same units as the pill. */
export type TitleBlockBand = PillRect;

export interface ContinuationPill {
  anchor: PillAnchor;
  /** Anchor point — the box edge that faces the page boundary. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The title-block band in page-local inches, measured from the sheet's top-left
 * corner: full margin-to-margin width capped to the configured width, flush with
 * the right-hand drawing border, sitting on the bottom margin.
 */
export function titleBlockBandInches(
  pageWIn: number,
  pageHIn: number,
  widthIn: number,
  heightIn: number,
): TitleBlockBand | null {
  const fullWidth = pageWIn - 2 * PAGE_MARGIN_IN;
  if (heightIn <= 0 || fullWidth <= 0) return null;
  const width = Math.min(widthIn, fullWidth);
  return {
    x: PAGE_MARGIN_IN + fullWidth - width,
    y: pageHIn - PAGE_MARGIN_IN - heightIn,
    width,
    height: heightIn,
  };
}

/** The same band in canvas pixels, for a page the print grid has laid out. */
export function titleBlockBandPx(
  page: PageRect,
  widthIn: number,
  heightIn: number,
): TitleBlockBand | null {
  const marginPx = page.contentX - page.x;
  if (marginPx <= 0) return null;
  const pxPerIn = marginPx / PAGE_MARGIN_IN;
  const band = titleBlockBandInches(page.widthPx / pxPerIn, page.heightPx / pxPerIn, widthIn, heightIn);
  if (!band) return null;
  return {
    x: page.x + band.x * pxPerIn,
    y: page.y + band.y * pxPerIn,
    width: band.width * pxPerIn,
    height: band.height * pxPerIn,
  };
}

/** Top-left corner of the pill's box: it grows inward, away from the boundary. */
function placePill(pill: ContinuationPill): PillRect {
  const { anchor, x, y, width, height } = pill;
  switch (anchor) {
    case "left":
      return { x: x - width, y: y - height / 2, width, height };
    case "right":
      return { x, y: y - height / 2, width, height };
    case "up":
      return { x: x - width / 2, y: y - height, width, height };
    case "down":
      return { x: x - width / 2, y, width, height };
  }
}

/**
 * Lift a pill clear of a title-block band. The pill is opaque, so one that lands on
 * the band whites out the drawing's own titling. A pill sharing no horizontal span
 * with the band — the block is right-aligned and usually narrower than the sheet —
 * is left exactly where it is; one that overlaps rides up until its bottom edge
 * rests on the band's top edge, the closest it can stay to its crossing point. A
 * pill merely touching an edge of the band does not overlap and is left alone.
 */
export function clampPillAboveBand(box: PillRect, band: TitleBlockBand | null): PillRect {
  if (!band || band.width <= 0 || band.height <= 0) return box;
  if (box.x >= band.x + band.width || box.x + box.width <= band.x) return box;
  if (box.y >= band.y + band.height || box.y + box.height <= band.y) return box;
  return { ...box, y: band.y - box.height };
}

/**
 * Place a continuation pill's box and keep it out of every title-block band it
 * would otherwise cover. Both the editor overlay and the PDF export call this, so
 * the two surfaces cannot drift apart.
 */
export function layoutContinuationPill(
  pill: ContinuationPill,
  bands: readonly TitleBlockBand[],
): PillRect {
  let box = placePill(pill);
  for (const band of bands) {
    box = clampPillAboveBand(box, band);
  }
  return box;
}
