// Resolution of a stub-label's display parts out of schematic state. Extracted from
// StubLabelNode.tsx so the DXF exporter can emit the SAME text the canvas shows (#319)
// instead of reimplementing the far-end walk — or, as it did, emitting nothing and
// leaving the leg's cable ID as the only text at a stub end.
//
// The far end of a stubbed connection is reached through the PARTNER leg: the two legs
// share a linkedConnectionId, and each terminates at one stub-label node. The device this
// stub names is the one at the other end of the partner leg, never our own.

import { resolvePortLabel } from "./packList";
import { computePageGrid } from "./printPageGrid";
import { getPaperSize, type Orientation } from "./printConfig";
import type { StubLabelParts } from "./stubLabelText";
import type {
  ConnectionEdge,
  SchematicNode,
  StubLabelData,
  TitleBlockLayout,
} from "./types";

export interface StubLabelContext {
  nodes: SchematicNode[];
  edges: ConnectionEdge[];
  /** 1-indexed printed page holding a canvas point, 0 when off-page. Omit outside
   *  print view or on a single-page drawing — page tags are then never resolved. */
  pageAt?: (x: number, y: number) => number;
}

/** Walk the parent chain to an absolute canvas position. */
function absolutePos(
  node: SchematicNode | undefined,
  nodeMap: Map<string, SchematicNode>,
): { x: number; y: number } {
  if (!node) return { x: 0, y: 0 };
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  while (parentId) {
    const parent = nodeMap.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/** The stub's own leg: a source-side stub is the TARGET of an edge from a device,
 *  a target-side stub is the SOURCE of an edge to one. */
function findOwnEdge(
  stubId: string,
  side: "source" | "target",
  edges: ConnectionEdge[],
): ConnectionEdge | undefined {
  return edges.find((e) => (side === "source" ? e.target === stubId : e.source === stubId));
}

/** The partner stub node — same linkedConnectionId, opposite side. */
function findPartnerStub(
  linkedConnectionId: string,
  mySide: "source" | "target",
  nodes: SchematicNode[],
): SchematicNode | undefined {
  const otherSide = mySide === "source" ? "target" : "source";
  return nodes.find(
    (n) =>
      n.type === "stub-label" &&
      (n.data as StubLabelData).linkedConnectionId === linkedConnectionId &&
      (n.data as StubLabelData).side === otherSide,
  );
}

/**
 * Resolve the parts of a stub-label's text. `farLabel` and `farRoom` come back RAW —
 * applying the display-case preference is the caller's job, so the arrow and the "Pg"
 * tag stay untouched (#294). `farPort` arrives already transformed, since
 * resolvePortLabel runs the transform itself.
 *
 * Returns null when the partner leg or the far device can't be resolved; the canvas
 * renders "?" in that state.
 */
export function resolveStubLabelParts(
  stubId: string,
  data: Pick<StubLabelData, "side" | "linkedConnectionId">,
  ctx: StubLabelContext,
): StubLabelParts | null {
  const { nodes, edges } = ctx;
  const ownEdge = findOwnEdge(stubId, data.side, edges);
  if (!ownEdge) return null;
  const partnerEdge = edges.find(
    (e) => e.data?.linkedConnectionId === data.linkedConnectionId && e.id !== ownEdge.id,
  );
  if (!partnerEdge) return null;

  const farDeviceId = data.side === "source" ? partnerEdge.target : partnerEdge.source;
  const farHandleId = data.side === "source" ? partnerEdge.targetHandle : partnerEdge.sourceHandle;
  const farDevice = nodes.find((n) => n.id === farDeviceId);
  if (!farDevice) return null;

  const farLabel = ((farDevice.data as Record<string, unknown>)?.label as string) ?? "";
  const farRoom = farDevice.parentId
    ? nodes.find((n) => n.id === farDevice.parentId)
    : null;
  const farRoomLabel = ((farRoom?.data as Record<string, unknown>)?.label as string) ?? "";
  const farPort = resolvePortLabel(farDevice, farHandleId ?? null);

  // Partner stub's position relative to ours drives the arrow direction.
  const partnerStub = findPartnerStub(data.linkedConnectionId, data.side, nodes);
  const nodeMap = new Map(nodes.map((n) => [n.id, n] as const));
  const myAbs = absolutePos(nodes.find((n) => n.id === stubId), nodeMap);
  const partnerAbs = partnerStub ? absolutePos(partnerStub, nodeMap) : myAbs;
  const dx = partnerAbs.x - myAbs.x;
  const dy = partnerAbs.y - myAbs.y;
  let arrow: string;
  if (Math.abs(dx) >= Math.abs(dy)) arrow = dx >= 0 ? "→" : "←";
  else arrow = dy >= 0 ? "↓" : "↑";

  let myPage = "";
  let farPage = "";
  if (ctx.pageAt) {
    const farAbs = absolutePos(farDevice, nodeMap);
    const mp = ctx.pageAt(myAbs.x, myAbs.y);
    const fp = ctx.pageAt(farAbs.x, farAbs.y);
    if (mp > 0) myPage = String(mp);
    if (fp > 0) farPage = String(fp);
  }

  return { arrow, farLabel, farPort, farRoom: farRoomLabel, myPage, farPage };
}

/** The subset of store state the page lookup needs. */
export interface PrintPageLookupState {
  printView: boolean;
  printPaperId: string;
  printCustomWidthIn?: number;
  printCustomHeightIn?: number;
  printOrientation: Orientation;
  printScale: number;
  printOriginOffsetX: number;
  printOriginOffsetY: number;
  titleBlockLayout?: TitleBlockLayout | null;
  nodes: SchematicNode[];
}

/**
 * Build the point → page-number lookup stub labels tag themselves with, or undefined
 * when there are no page numbers to show (not in print view, or a single page).
 */
export function buildPrintPageLookup(
  s: PrintPageLookupState,
): ((x: number, y: number) => number) | undefined {
  if (!s.printView) return undefined;
  const paperSize = getPaperSize(s.printPaperId, s.printCustomWidthIn, s.printCustomHeightIn);
  const pages = computePageGrid(
    paperSize, s.printOrientation, s.printScale, s.nodes,
    s.titleBlockLayout?.heightIn ?? 1, s.printOriginOffsetX, s.printOriginOffsetY,
  );
  if (pages.length <= 1) return undefined;
  return (x, y) => {
    for (const p of pages) {
      if (x >= p.x && x < p.x + p.widthPx && y >= p.y && y < p.y + p.heightPx) return p.index + 1;
    }
    return 0;
  };
}
