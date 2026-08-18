/**
 * #318 — "Rerouting a stub leaves '?' on both ends of the link".
 *
 * A stubbed connection is two legs sharing a linkedConnectionId, each terminating at a
 * stub-label tag. Removing ONE leg (a fumbled reconnect drag, or Delete on a single
 * selected leg) used to leave the partner leg and both tags behind. StubLabelNode renders
 * "?" whenever it can't find its own leg OR its partner leg, so a half-removed link showed
 * "?" at BOTH ends — exactly the reported symptom. These tests drive the real store paths.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { ConnectionEdge, SchematicNode, StubLabelData } from "../types";

function installLocalStorageStub() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  });
}

let useSchematicStore: typeof import("../store").useSchematicStore;

beforeAll(async () => {
  installLocalStorageStub();
  ({ useSchematicStore } = await import("../store"));
});
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  useSchematicStore.getState().newSchematic();
  useSchematicStore.setState({ toasts: [] }); // newSchematic leaves them standing
});

const LINK = "link-7c31e0a2";

/** dev-cam ──▶ [tag-src]   [tag-tgt] ──▶ dev-switcher */
function seedStubbedConnection() {
  const nodes: SchematicNode[] = [
    { id: "dev-cam", type: "device", position: { x: 0, y: 100 },
      data: { label: "CAM-01", deviceType: "camera",
        ports: [{ id: "p1", label: "SDI OUT", signalType: "sdi", direction: "output" }] } } as unknown as SchematicNode,
    { id: "dev-switcher", type: "device", position: { x: 900, y: 100 },
      data: { label: "SWITCHER", deviceType: "misc",
        ports: [{ id: "p1", label: "SDI IN 1", signalType: "sdi", direction: "input" }] } } as unknown as SchematicNode,
    { id: "stub-e1-src", type: "stub-label", position: { x: 208, y: 141 }, zIndex: 100,
      measured: { width: 137, height: 14 },
      data: { signalType: "sdi", linkedConnectionId: LINK, side: "source", placed: true } } as unknown as SchematicNode,
    { id: "stub-e1-tgt", type: "stub-label", position: { x: 699, y: 141 }, zIndex: 100,
      measured: { width: 137, height: 14 },
      data: { signalType: "sdi", linkedConnectionId: LINK, side: "target", placed: true } } as unknown as SchematicNode,
  ];
  const edges: ConnectionEdge[] = [
    { id: "e1-src", source: "dev-cam", sourceHandle: "p1", target: "stub-e1-src", targetHandle: "l",
      data: { signalType: "sdi", linkedConnectionId: LINK, cableId: "SDI-001" } } as unknown as ConnectionEdge,
    { id: "e1-tgt", source: "stub-e1-tgt", sourceHandle: "r", target: "dev-switcher", targetHandle: "p1",
      data: { signalType: "sdi", linkedConnectionId: LINK } } as unknown as ConnectionEdge,
  ];
  useSchematicStore.setState({ nodes, edges });
}

/** Give the target half a user-dragged path handle, with its waypoint node in place. */
function addPathHandleToTargetLeg() {
  const s = useSchematicStore.getState();
  useSchematicStore.setState({
    edges: s.edges.map((e) =>
      e.id === "e1-tgt" ? { ...e, data: { ...e.data!, manualWaypoints: [{ x: 800, y: 300 }] } } : e,
    ),
    nodes: [
      ...s.nodes,
      { id: "wp-e1-tgt-0", type: "waypoint", position: { x: 800, y: 300 }, zIndex: 100,
        data: { edgeId: "e1-tgt", index: 0 } } as unknown as SchematicNode,
    ],
  });
}

/** Mirrors StubLabelNode's label selector: "" (rendered as "?") when either leg is missing. */
function tagResolves(tagId: string): boolean {
  const s = useSchematicStore.getState();
  const tag = s.nodes.find((n) => n.id === tagId);
  if (!tag) return false;
  const data = tag.data as StubLabelData;
  const ownEdge = s.edges.find((e) => (data.side === "source" ? e.target : e.source) === tagId);
  if (!ownEdge) return false;
  return s.edges.some((e) => e.data?.linkedConnectionId === data.linkedConnectionId && e.id !== ownEdge.id);
}

describe("stubbed connections survive or vanish as a pair (#318)", () => {
  it("both tags resolve while the link is whole", () => {
    seedStubbedConnection();
    expect(tagResolves("stub-e1-src")).toBe(true);
    expect(tagResolves("stub-e1-tgt")).toBe(true);
  });

  it("deleting one leg removes the whole link instead of stranding two '?' tags", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteConnection("e1-tgt");

    const s = useSchematicStore.getState();
    expect(s.edges.filter((e) => e.data?.linkedConnectionId === LINK)).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
    // The devices themselves are untouched.
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("deleting a stub tag takes its partner leg and tag with it", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteNode("stub-e1-src");

    const s = useSchematicStore.getState();
    expect(s.edges.filter((e) => e.data?.linkedConnectionId === LINK)).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
  });

  it("React Flow's own remove change also cascades the pair", () => {
    seedStubbedConnection();
    useSchematicStore.getState().onEdgesChange([{ id: "e1-src", type: "remove" }]);

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
  });

  it("deleting one device drops the stubbed connection it carried, not just its own leg", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteNode("dev-switcher");

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.map((n) => n.id)).toEqual(["dev-cam"]);
  });

  it("takes the cascaded half's path handles with it, via deleteConnection", () => {
    seedStubbedConnection();
    addPathHandleToTargetLeg();
    useSchematicStore.getState().deleteConnection("e1-src");

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    // The path handle belonged to the OTHER half — the one the cascade removed. It must
    // not survive as a draggable node (and be saved) just because the pair reconcile ran
    // after the waypoint reconcile.
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("takes the cascaded half's path handles with it, via onEdgesChange", () => {
    seedStubbedConnection();
    addPathHandleToTargetLeg();
    useSchematicStore.getState().onEdgesChange([{ id: "e1-src", type: "remove" }]);

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.map((n) => n.id).sort()).toEqual(["dev-cam", "dev-switcher"]);
  });

  it("says so when deleting one half took the other with it", () => {
    seedStubbedConnection();
    useSchematicStore.getState().deleteConnection("e1-tgt");
    const toasts = useSchematicStore.getState().toasts;
    expect(toasts.some((t) => /stub connection/i.test(t.message))).toBe(true);
  });

  it("stays quiet when the whole stubbed connection was selected", () => {
    seedStubbedConnection();
    useSchematicStore.setState({
      edges: useSchematicStore.getState().edges.map((e) => ({ ...e, selected: true })),
    });
    useSchematicStore.getState().removeSelected();

    const s = useSchematicStore.getState();
    expect(s.edges).toEqual([]);
    expect(s.nodes.filter((n) => n.type === "stub-label")).toEqual([]);
    expect(s.toasts).toEqual([]);
  });

  it("reports the cascade count on its return value, not just the toast", () => {
    // The MCP bridge's delete_connection has no toast to read — it needs deleteConnection's
    // own return value to tell an agent it removed more than the id it was asked for.
    seedStubbedConnection();
    const result = useSchematicStore.getState().deleteConnection("e1-tgt");
    expect(result).toEqual({ removedStubLinks: 1 });
  });

  it("returns zero cascaded links for a plain connection or an unknown id", () => {
    seedStubbedConnection();
    useSchematicStore.setState({
      edges: [...useSchematicStore.getState().edges,
        { id: "plain", source: "dev-cam", sourceHandle: "p1",
          target: "dev-switcher", targetHandle: "p1", data: { signalType: "sdi" } } as unknown as ConnectionEdge],
    });
    expect(useSchematicStore.getState().deleteConnection("plain")).toEqual({ removedStubLinks: 0 });
    expect(useSchematicStore.getState().deleteConnection("no-such-edge")).toEqual({ removedStubLinks: 0 });
  });

  it("leaves an untouched stubbed connection completely alone", () => {
    seedStubbedConnection();
    const before = useSchematicStore.getState();
    const nodesBefore = before.nodes;
    const edgesBefore = before.edges;
    // Deleting an unrelated plain connection must not disturb the pair.
    useSchematicStore.setState({
      edges: [...edgesBefore, { id: "plain", source: "dev-cam", sourceHandle: "p1",
        target: "dev-switcher", targetHandle: "p1", data: { signalType: "sdi" } } as unknown as ConnectionEdge],
    });
    useSchematicStore.getState().deleteConnection("plain");

    const s = useSchematicStore.getState();
    expect(s.edges.map((e) => e.id).sort()).toEqual(["e1-src", "e1-tgt"]);
    expect(s.nodes.length).toBe(nodesBefore.length);
    expect(tagResolves("stub-e1-src")).toBe(true);
    expect(tagResolves("stub-e1-tgt")).toBe(true);
  });
});
