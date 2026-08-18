/**
 * #323 — "Stub labels anchor to distant elements instead of their source connector".
 *
 * computeSnap offered every port of every device within MAX_SNAP_DISTANCE (800px) as a
 * snap target for a dragged stub tag, and pickBest ranks all port candidates equally by
 * |delta|. Any unrelated device whose port row happened to be a few px closer therefore
 * won, latching the tag onto a connector it has nothing to do with. Only the tag's OWN
 * port — the device end of its leg — may snap now.
 */
import { describe, it, expect } from "vitest";
import { computeSnap, getPortAbsolutePositions } from "../snapUtils";
import { STUB_GAP, STUB_H_EST } from "../stubPlacement";
import type { ConnectionEdge, Port, SchematicNode } from "../types";

const port = (id: string, label: string, direction: Port["direction"]): Port =>
  ({ id, label, signalType: "sdi", direction } as Port);

const device = (id: string, label: string, x: number, y: number, ports: Port[]): SchematicNode =>
  ({
    id, type: "device", position: { x, y },
    data: { label, deviceType: "misc", ports },
    measured: { width: 144, height: 48 + ports.length * 20 },
  } as unknown as SchematicNode);

const tag = (id: string, x: number, y: number): SchematicNode =>
  ({
    id, type: "stub-label", position: { x, y },
    data: { signalType: "sdi", linkedConnectionId: "link-1", side: "target", placed: true },
    measured: { width: 137, height: STUB_H_EST },
  } as unknown as SchematicNode);

/** The tag's own leg: tag ──▶ device port (a target-side leg). */
const leg = (tagId: string, deviceId: string, handleId: string): ConnectionEdge =>
  ({
    id: "e1-tgt", source: tagId, sourceHandle: "r", target: deviceId, targetHandle: handleId,
    data: { signalType: "sdi", linkedConnectionId: "link-1" },
  } as unknown as ConnectionEdge);

function portRow(dev: SchematicNode, handleId: string, nodes: SchematicNode[]) {
  const map = new Map(nodes.map((n) => [n.id, n] as const));
  const p = getPortAbsolutePositions(dev, map).find((q) => q.handleId === handleId);
  if (!p) throw new Error(`no port ${handleId}`);
  return p;
}

describe("stub tags snap to their own connector, not a neighbour's (#323)", () => {
  // Own device: SWITCHER at x=900. A decoy rack sits 300px to the left with a port row
  // 6px off the tag's current row — inside SNAP_THRESHOLD (20px), and nearer than the
  // tag's own port row, so it used to win outright.
  const own = device("dev-switcher", "SWITCHER", 900, 100, [
    port("p1", "SDI IN 1", "input"),
    port("p2", "SDI IN 2", "input"),
  ]);
  const decoy = device("dev-decoy", "PATCH RACK", 300, 60, [
    port("q1", "TIE 1", "input"),
    port("q2", "TIE 2", "input"),
    port("q3", "TIE 3", "input"),
  ]);

  it("aligns the tag's centre with its own port row", () => {
    const base = [own, decoy];
    const ownPort = portRow(own, "p1", base);
    const decoyPort = portRow(decoy, "q3", base);
    // Sanity: the decoy row really is the closer temptation for this drag.
    const dropY = ownPort.absY - 14;
    expect(Math.abs(decoyPort.absY - dropY)).toBeLessThan(Math.abs(ownPort.absY - dropY));
    expect(Math.abs(decoyPort.absY - dropY)).toBeLessThanOrEqual(20);

    const dragged = tag("stub-e1-tgt", ownPort.absX - STUB_GAP - 137, dropY - STUB_H_EST / 2);
    const nodes = [...base, dragged];
    const snap = computeSnap(dragged, nodes, undefined, [leg(dragged.id, "dev-switcher", "p1")]);

    // Tag centre lands on its own port's row, not the decoy's.
    expect(snap.y + STUB_H_EST / 2).toBe(ownPort.absY);
    expect(snap.y + STUB_H_EST / 2).not.toBe(decoyPort.absY);
  });

  it("parks the tag STUB_GAP from its own port on the X axis", () => {
    const base = [own, decoy];
    const ownPort = portRow(own, "p1", base);
    // Dropped 9px short of the canonical gap — within threshold, so the snap closes it.
    const dragged = tag("stub-e1-tgt", ownPort.absX - STUB_GAP - 137 + 9, ownPort.absY - STUB_H_EST / 2);
    const nodes = [...base, dragged];
    const snap = computeSnap(dragged, nodes, undefined, [leg(dragged.id, "dev-switcher", "p1")]);

    expect(snap.x + 137).toBe(ownPort.absX - STUB_GAP);
  });

  it("heals a bare handle ref against a port that became bidirectional", () => {
    const bidir = device("dev-bidir", "MATRIX", 900, 100, [
      port("p1", "SDI 1", "bidirectional"),
    ]);
    const base = [bidir, decoy];
    const p = getPortAbsolutePositions(bidir, new Map(base.map((n) => [n.id, n] as const)))
      .find((q) => q.portId === "p1")!;
    const dragged = tag("stub-e1-tgt", p.absX - STUB_GAP - 137, p.absY - STUB_H_EST / 2 - 6);
    const nodes = [...base, dragged];
    // Leg stored against the bare port id, from before the port went bidirectional.
    const snap = computeSnap(dragged, nodes, undefined, [leg(dragged.id, "dev-bidir", "p1")]);

    expect(snap.y + STUB_H_EST / 2).toBe(p.absY);
  });

  it("still uses nearby ports for a tag whose leg is gone", () => {
    // An orphaned tag has no own port to anchor to — the old nearest-device scan is the
    // only thing left, and it must still work rather than dropping to bare grid snap.
    const base = [own, decoy];
    const decoyPort = portRow(decoy, "q3", base);
    const dragged = tag("stub-orphan", decoyPort.absX - STUB_GAP - 137, decoyPort.absY - STUB_H_EST / 2 - 5);
    const snap = computeSnap(dragged, [...base, dragged], undefined, []);
    expect(snap.y + STUB_H_EST / 2).toBe(decoyPort.absY);
  });
});
