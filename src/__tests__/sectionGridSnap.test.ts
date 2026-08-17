import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../migrations";
import { GRID_SIZE } from "../gridConstants";
import { computeSnap, enforceMinSpacing, snapParentedRestPosition } from "../snapUtils";
import type { SchematicFile, SchematicNode } from "../types";

/**
 * Regression tests for #322 — devices inside a room ("section") must land on the
 * same ABSOLUTE snapping grid as top-level devices. A parented device stores
 * room-relative coords; when the room origin sits off-grid (edge-aligned resize,
 * older saves), snapping in relative space leaves the device's ports off the
 * grid and cables to outside devices kink.
 */

// The store reads/writes localStorage at module init; vitest runs in the node
// environment where it is absent, so install an in-memory stub before import.
function installLocalStorageStub() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  });
}

let useSchematicStore: typeof import("../store").useSchematicStore;

beforeAll(async () => {
  installLocalStorageStub();
  ({ useSchematicStore } = await import("../store"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  useSchematicStore.getState().newSchematic();
});

function room(id: string, x: number, y: number, parentId?: string): SchematicNode {
  return {
    id,
    type: "room",
    position: { x, y },
    parentId,
    style: { width: 400, height: 300 },
    data: { label: id },
  } as SchematicNode;
}

function device(id: string, x: number, y: number, parentId?: string): SchematicNode {
  return {
    id,
    type: "device",
    position: { x, y },
    parentId,
    measured: { width: 144, height: 96 },
    data: { label: id, deviceType: "misc", ports: [] },
  } as SchematicNode;
}

/** Absolute position by walking the parent chain of the CURRENT store nodes. */
function absPos(nodes: SchematicNode[], id: string): { x: number; y: number } {
  const map = new Map(nodes.map((n) => [n.id, n]));
  const n = map.get(id)!;
  let x = n.position.x;
  let y = n.position.y;
  let pid = n.parentId;
  while (pid) {
    const p = map.get(pid);
    if (!p) break;
    x += p.position.x;
    y += p.position.y;
    pid = p.parentId;
  }
  return { x, y };
}

function expectOnGrid(pos: { x: number; y: number }) {
  // Math.abs so a negative coordinate's -0 remainder still compares equal to 0.
  expect(Math.abs(pos.x % GRID_SIZE)).toBe(0);
  expect(Math.abs(pos.y % GRID_SIZE)).toBe(0);
}

describe("load-time grid snap (#322)", () => {
  it("puts a sectioned device on the absolute grid even when the room origin is off-grid", () => {
    const file: SchematicFile = {
      version: CURRENT_SCHEMA_VERSION,
      name: "off-grid room",
      nodes: [room("room-1", 103, 57), device("dev-1", 61, 39, "room-1")],
      edges: [],
    };
    useSchematicStore.getState().importFromJSON(file);

    const nodes = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(nodes, "room-1"));
    expectOnGrid(absPos(nodes, "dev-1"));
  });

  it("handles nested parents (rack inside a room) in absolute space", () => {
    const rack = room("rack-1", 37, 21, "room-1");
    (rack.data as { isEquipmentRack?: boolean }).isEquipmentRack = true;
    const file: SchematicFile = {
      version: CURRENT_SCHEMA_VERSION,
      name: "nested off-grid",
      nodes: [room("room-1", 103, 57), rack, device("dev-1", 13, 9, "rack-1")],
      edges: [],
    };
    useSchematicStore.getState().importFromJSON(file);

    const nodes = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(nodes, "rack-1"));
    expectOnGrid(absPos(nodes, "dev-1"));
  });
});

describe("snapRoomChildrenToGrid (#322)", () => {
  it("re-snaps children in absolute space after a room's origin moved off-grid", () => {
    // Post-resize state: room origin off-grid, child relative coords still
    // grid-multiples — so the child's ABSOLUTE position is off-grid.
    useSchematicStore.setState({
      nodes: [room("room-1", 100, 50), device("dev-1", 64, 32, "room-1")],
    });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");

    const nodes = useSchematicStore.getState().nodes;
    // The room itself is left alone (its off-grid origin can be deliberate,
    // e.g. edge-aligned to another room)...
    expect(absPos(nodes, "room-1")).toEqual({ x: 100, y: 50 });
    // ...but the device lands on the absolute grid regardless.
    expectOnGrid(absPos(nodes, "dev-1"));
  });

  it("snaps nested children against the snapped position of their parent", () => {
    useSchematicStore.setState({
      nodes: [
        room("room-1", 100, 50),
        room("rack-1", 30, 30, "room-1"),
        device("dev-1", 10, 10, "rack-1"),
      ],
    });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");

    const nodes = useSchematicStore.getState().nodes;
    expectOnGrid(absPos(nodes, "rack-1"));
    expectOnGrid(absPos(nodes, "dev-1"));
  });

  it("is a no-op when children already sit on the absolute grid", () => {
    const before = [room("room-1", 100, 48), device("dev-1", 60, 32, "room-1")];
    useSchematicStore.setState({ nodes: before });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-1");
    // dev-1 abs = (160, 80) — already grid-aligned, so the node array is untouched.
    expect(useSchematicStore.getState().nodes).toBe(before);
  });
});

describe("onRoomResizeEnd (#322)", () => {
  it("snaps a device the resize pushed OUT of the room, not just remaining children", () => {
    // Post-resize state after dragging the left edge right by an unsnapped 105px:
    // origin (105, 0), width shrunk to 295. Both children kept their relative
    // coords, so their absolute x shifted off-grid by the same 105px. dev-out's
    // center now falls outside the bounds — reparentAllDevices detaches it at
    // that off-grid absolute position, and it must STILL be pulled onto the grid.
    const shrunk = room("room-1", 105, 0);
    shrunk.style = { width: 295, height: 300 };
    useSchematicStore.setState({
      nodes: [
        shrunk,
        device("dev-in", 32, 32, "room-1"), // abs (137, 32), center inside
        device("dev-out", 352, 32, "room-1"), // abs (457, 32), center outside
      ],
    });
    useSchematicStore.getState().onRoomResizeEnd("room-1");

    const nodes = useSchematicStore.getState().nodes;
    const map = new Map(nodes.map((n) => [n.id, n]));
    expect(map.get("dev-out")!.parentId).toBeUndefined();
    expectOnGrid(absPos(nodes, "dev-out"));
    expect(map.get("dev-in")!.parentId).toBe("room-1");
    expectOnGrid(absPos(nodes, "dev-in"));
  });
});

describe("enforceMinSpacing rounds in absolute space (#322)", () => {
  it("returns a position whose ABSOLUTE coords are grid-aligned for a sectioned device", () => {
    const roomNode = room("room-1", 103, 57);
    const dragged = device("dev-1", 32, 32, "room-1");
    const neighbor = device("dev-2", 40, 40, "room-1"); // overlaps → forces a correction
    const corrected = enforceMinSpacing(dragged, [roomNode, dragged, neighbor]);

    expect(corrected).not.toBeNull();
    expectOnGrid({ x: corrected!.x + 103, y: corrected!.y + 57 });
  });

  it("still rounds plain top-level devices to the grid", () => {
    const dragged = device("dev-1", 32, 32);
    const neighbor = device("dev-2", 40, 40);
    const corrected = enforceMinSpacing(dragged, [dragged, neighbor]);

    expect(corrected).not.toBeNull();
    expectOnGrid(corrected!);
  });
});

describe("drag-stop rest position inside an off-grid room (#322)", () => {
  it("rounds a plain drag with no alignment and no neighbor onto the ABSOLUTE grid", () => {
    // The scenario computeSnap/enforceMinSpacing both pass through untouched:
    // React Flow's snapGrid grid-rounded the RELATIVE coords, the room origin is
    // off-grid, and there is nothing nearby to align with or push against.
    const roomNode = room("room-1", 103, 57);
    const dev = device("dev-1", 64, 32, "room-1");
    const all = [roomNode, dev];

    const snap = computeSnap(dev, all);
    expect({ x: snap.x, y: snap.y }).toEqual({ x: 64, y: 32 }); // identity
    expect(enforceMinSpacing(dev, all, undefined, snap)).toBeNull(); // no overlap

    const nodeMap = new Map(all.map((n) => [n.id, n]));
    const rest = snapParentedRestPosition(dev, { x: snap.x, y: snap.y }, nodeMap);
    expectOnGrid({ x: rest.x + 103, y: rest.y + 57 });
  });

  it("leaves an axis the snap engine moved alone — alignment can be deliberately off-grid", () => {
    const roomNode = room("room-1", 103, 57);
    const dev = device("dev-1", 64, 32, "room-1");
    const nodeMap = new Map([roomNode, dev].map((n) => [n.id as string, n]));

    // x differs from the rest position (an alignment snap fired), y did not.
    const rest = snapParentedRestPosition(dev, { x: 61, y: 32 }, nodeMap);
    expect(rest.x).toBe(61);
    expect(Math.abs((rest.y + 57) % GRID_SIZE)).toBe(0);
  });

  it("is a no-op for top-level devices and stubs", () => {
    const dev = device("dev-1", 61, 39);
    const nodeMap = new Map<string, SchematicNode>([[dev.id, dev]]);
    expect(snapParentedRestPosition(dev, { x: 61, y: 39 }, nodeMap)).toEqual({ x: 61, y: 39 });

    const roomNode = room("room-1", 103, 57);
    const stub = {
      ...device("stub-1", 64, 30.5, "room-1"),
      type: "stub-label",
    } as SchematicNode;
    const map2 = new Map([roomNode, stub].map((n) => [n.id as string, n]));
    expect(snapParentedRestPosition(stub, { x: 64, y: 30.5 }, map2)).toEqual({ x: 64, y: 30.5 });
  });
});

describe("cyclic parentId chains (corrupt saves) terminate (#322)", () => {
  function cyclicNodes(): SchematicNode[] {
    return [
      room("room-a", 103, 57, "room-b"),
      room("room-b", 50, 50, "room-a"),
      device("dev-1", 61, 39, "room-a"),
    ];
  }

  it("loads a file whose rooms parent each other without hanging", () => {
    const file: SchematicFile = {
      version: CURRENT_SCHEMA_VERSION,
      name: "cyclic",
      nodes: cyclicNodes(),
      edges: [],
    };
    useSchematicStore.getState().importFromJSON(file);
    const nodes = useSchematicStore.getState().nodes;
    expect(nodes).toHaveLength(3);
    // Import must BREAK the cycle, not just survive it — React Flow's own
    // parent resolution and the edge router walk parentId unguarded, so a
    // cycle that reaches the canvas still hangs the tab at first render.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const seen = new Set<string>();
      let cur = n as SchematicNode | undefined;
      while (cur?.parentId) {
        expect(seen.has(cur.id)).toBe(false);
        seen.add(cur.id);
        cur = byId.get(cur.parentId);
      }
    }
  });

  it("snapRoomChildrenToGrid terminates and still snaps the child", () => {
    useSchematicStore.setState({ nodes: cyclicNodes() });
    useSchematicStore.getState().snapRoomChildrenToGrid("room-a");
    const dev = useSchematicStore.getState().nodes.find((n) => n.id === "dev-1")!;
    expect(Number.isFinite(dev.position.x)).toBe(true);
    expect(Number.isFinite(dev.position.y)).toBe(true);
  });

  it("onRoomResizeEnd terminates on a cycle", () => {
    useSchematicStore.setState({ nodes: cyclicNodes() });
    useSchematicStore.getState().onRoomResizeEnd("room-a");
    expect(useSchematicStore.getState().nodes).toHaveLength(3);
  });

  it("enforceMinSpacing terminates when the dragged node's chain is cyclic", () => {
    const [roomA, roomB] = cyclicNodes();
    const dragged = device("dev-1", 32, 32, "room-a");
    const neighbor = device("dev-2", 40, 40, "room-a");
    const corrected = enforceMinSpacing(dragged, [roomA, roomB, dragged, neighbor]);
    expect(corrected).not.toBeNull();
  });
});
