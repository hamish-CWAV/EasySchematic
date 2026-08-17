/**
 * Editing a connected port's connector/signal type revalidates its connections (#306).
 *
 * Validity was only checked when a connection was made (isValidConnection / onConnect),
 * so editing a connected port into an incompatible state left the cable silently wrong.
 * findInvalidatedConnections re-runs the connect-time rules for every connection the
 * edit touched, and updateDevice stages the failures as pendingPortEditConflicts for
 * the user to disconnect, adapt, or knowingly keep.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { findAdaptersForConnectorBridge } from "../connectorTypes";
import { DEVICE_TEMPLATES } from "../deviceLibrary";
import type { ConnectionEdge, ConnectorType, DeviceData, DeviceNode, DeviceTemplate, Port, SchematicNode } from "../types";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key() { return null; }
  get length() { return this.m.size; }
}

let useSchematicStore: typeof import("../store")["useSchematicStore"];
let findInvalidatedConnections: typeof import("../store")["findInvalidatedConnections"];

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore, findInvalidatedConnections } = await import("../store"));
});

function port(id: string, overrides: Partial<Port> = {}): Port {
  return { id, label: id, signalType: "hdmi", direction: "output", connectorType: "hdmi", ...overrides };
}

function device(id: string, ports: Port[], x = 0): DeviceNode {
  return {
    id,
    type: "device",
    position: { x, y: 0 },
    data: { label: id, deviceType: "source", ports },
  } as DeviceNode;
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string, data: ConnectionEdge["data"] = { signalType: "hdmi" }): ConnectionEdge {
  return { id, source, target, sourceHandle, targetHandle, data } as ConnectionEdge;
}

/** One-jack patch panel: a passthrough port whose faces carry the given connectors. */
function panel(id: string, front: ConnectorType, rear: ConnectorType = front): DeviceNode {
  return {
    id,
    type: "device",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      deviceType: "patch-panel",
      ports: [{ id: "p1", label: "1", signalType: "hdmi", direction: "passthrough", frontConnectorType: front, rearConnectorType: rear }],
    },
  } as DeviceNode;
}

/** Player HDMI out → Display HDMI in, connected. */
function baseSchematic(): { nodes: SchematicNode[]; edges: ConnectionEdge[] } {
  const player = device("n1", [port("out1", { direction: "output" })]);
  const display = device("n2", [port("in1", { direction: "input" })], 400);
  return { nodes: [player, display], edges: [edge("e1", "n1", "out1", "n2", "in1")] };
}

function withEditedPort(nodes: SchematicNode[], nodeId: string, portId: string, patch: Partial<Port>): SchematicNode[] {
  return nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const data = n.data as DeviceData;
    return {
      ...n,
      data: { ...data, ports: data.ports.map((p) => (p.id === portId ? { ...p, ...patch } : p)) },
    } as DeviceNode;
  });
}

describe("findInvalidatedConnections", () => {
  it("reports nothing when the edit keeps the connection valid", () => {
    // ethercon natively accepts rj45 — a compatible connector swap stays quiet
    const src = device("n1", [port("out1", { signalType: "ethernet", connectorType: "rj45" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "ethernet", connectorType: "rj45" })], 400);
    const edges = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "ethernet" })];
    const oldPorts = tgt.data.ports;
    const edited = withEditedPort([src, tgt], "n2", "in1", { connectorType: "ethercon" });
    expect(findInvalidatedConnections(edited, edges, "n2", oldPorts)).toEqual([]);
  });

  it("reports nothing when no connector or signal actually changed", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { label: "Renamed" });
    expect(findInvalidatedConnections(edited, edges, "n2", oldPorts)).toEqual([]);
  });

  it("detects a signal edit that makes the connection invalid", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { signalType: "analog-audio", connectorType: "xlr-3" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].edgeId).toBe("e1");
    expect(conflicts[0].reason).toBe("signal-mismatch");
    expect(conflicts[0].sourcePort.id).toBe("out1");
    expect(conflicts[0].targetPort.id).toBe("in1");
  });

  it("detects a connector-only edit as a connector mismatch", () => {
    const { nodes, edges } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const edited = withEditedPort(nodes, "n2", "in1", { connectorType: "bnc" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("connector-mismatch");
  });

  it("only flags connections touching the edited port", () => {
    const player = device("n1", [port("out1"), port("out2")]);
    const display = device("n2", [port("in1", { direction: "input" }), port("in2", { direction: "input" })], 400);
    const edges = [
      edge("e1", "n1", "out1", "n2", "in1"),
      edge("e2", "n1", "out2", "n2", "in2"),
    ];
    const oldPorts = display.data.ports;
    const edited = withEditedPort([player, display], "n2", "in1", { signalType: "sdi", connectorType: "bnc" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts.map((c) => c.edgeId)).toEqual(["e1"]);
  });

  it("skips connections already accepted as mismatched", () => {
    const { nodes } = baseSchematic();
    const oldPorts = (nodes[1] as DeviceNode).data.ports;
    const flagged = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "hdmi", connectorMismatch: true })];
    const forced = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "hdmi", allowIncompatible: true })];
    const edited = withEditedPort(nodes, "n2", "in1", { signalType: "analog-audio", connectorType: "xlr-3" });
    expect(findInvalidatedConnections(edited, flagged, "n2", oldPorts)).toEqual([]);
    expect(findInvalidatedConnections(edited, forced, "n2", oldPorts)).toEqual([]);
  });

  it("finds an adapter for a conflicted connector pair via the existing matcher", () => {
    const src = device("n1", [port("out1", { signalType: "analog-audio", connectorType: "xlr-3" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "analog-audio", connectorType: "xlr-3" })], 400);
    const edges = [edge("e1", "n1", "out1", "n2", "in1", { signalType: "analog-audio" })];
    const oldPorts = tgt.data.ports;
    const edited = withEditedPort([src, tgt], "n2", "in1", { connectorType: "trs-quarter" });
    const conflicts = findInvalidatedConnections(edited, edges, "n2", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("connector-mismatch");
    const adapters = findAdaptersForConnectorBridge(
      conflicts[0].sourcePort.connectorType!,
      conflicts[0].targetPort.connectorType!,
      conflicts[0].sourcePort.signalType,
      DEVICE_TEMPLATES,
    );
    expect(adapters).toHaveLength(1);
  });

  it("classifies a passthrough face-connector edit by the face the cable uses", () => {
    // Patch-panel front jack (front=hdmi) cabled to an HDMI display; front edited to BNC.
    // The conflict must carry the effective face connectors, not the passthrough port's
    // (undefined) connectorType — otherwise it reads as an HDMI→HDMI signal mismatch.
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    const edges = [edge("e1", "pp", "p1-front", "n2", "in1")];
    const oldPorts = pp.data.ports;
    const edited = withEditedPort([pp, display], "pp", "p1", { frontConnectorType: "bnc" });
    const conflicts = findInvalidatedConnections(edited, edges, "pp", oldPorts);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe("connector-mismatch");
    expect(conflicts[0].sourceConnector).toBe("bnc");
    expect(conflicts[0].targetConnector).toBe("hdmi");
    expect(conflicts[0].sourceSignal).toBe("hdmi");
    expect(conflicts[0].targetSignal).toBe("hdmi");
  });

  it("ignores a rear-face edit when the cable is on the front face", () => {
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    const edges = [edge("e1", "pp", "p1-front", "n2", "in1")];
    const oldPorts = pp.data.ports;
    const edited = withEditedPort([pp, display], "pp", "p1", { rearConnectorType: "bnc" });
    expect(findInvalidatedConnections(edited, edges, "pp", oldPorts)).toEqual([]);
  });
});

describe("updateDevice port-edit revalidation flow", () => {
  beforeEach(() => {
    useSchematicStore.setState({
      nodes: [],
      edges: [],
      pendingPortEditConflicts: null,
      pendingIncompatibleConnection: null,
    });
  });

  function loadBase() {
    const { nodes, edges } = baseSchematic();
    useSchematicStore.setState({ nodes, edges });
  }

  function editDisplayPort(patch: Partial<Port>) {
    const state = useSchematicStore.getState();
    const display = state.nodes.find((n) => n.id === "n2") as DeviceNode;
    const data: DeviceData = {
      ...display.data,
      ports: display.data.ports.map((p) => (p.id === "in1" ? { ...p, ...patch } : p)),
    };
    state.updateDevice("n2", data);
  }

  it("stages conflicts when an edit invalidates a connection", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts![0].edgeId).toBe("e1");
  });

  it("stages nothing for a compatible edit", () => {
    loadBase();
    editDisplayPort({ label: "Renamed" });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });

  it("disconnect removes the invalid connection", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().resolvePortEditConflict("e1", "disconnect");
    const state = useSchematicStore.getState();
    expect(state.edges.find((e) => e.id === "e1")).toBeUndefined();
    expect(state.pendingPortEditConflicts).toBeNull();
  });

  it("keep flags the connection as a known mismatch", () => {
    loadBase();
    editDisplayPort({ signalType: "analog-audio", connectorType: "xlr-3" });
    useSchematicStore.getState().resolvePortEditConflict("e1", "keep");
    const state = useSchematicStore.getState();
    const kept = state.edges.find((e) => e.id === "e1");
    expect(kept?.data?.connectorMismatch).toBe(true);
    expect(state.pendingPortEditConflicts).toBeNull();
    // A later unrelated edit must not re-prompt for the accepted mismatch
    editDisplayPort({ connectorType: "trs-quarter" });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toBeNull();
  });

  it("insert adapter replaces the invalid cable with two adapter legs", () => {
    const src = device("n1", [port("out1", { signalType: "usb", connectorType: "usb-a" })]);
    const tgt = device("n2", [port("in1", { direction: "input", signalType: "usb", connectorType: "usb-a" })], 400);
    useSchematicStore.setState({
      nodes: [src, tgt],
      edges: [edge("e1", "n1", "out1", "n2", "in1", { signalType: "usb" })],
    });
    const state = useSchematicStore.getState();
    const display = state.nodes.find((n) => n.id === "n2") as DeviceNode;
    state.updateDevice("n2", {
      ...display.data,
      ports: display.data.ports.map((p) => (p.id === "in1" ? { ...p, connectorType: "usb-c" } : p)),
    });

    const conflicts = useSchematicStore.getState().pendingPortEditConflicts;
    expect(conflicts).toHaveLength(1);
    const adapters = findAdaptersForConnectorBridge("usb-a", "usb-c", "usb", DEVICE_TEMPLATES);
    expect(adapters.length).toBeGreaterThan(0);

    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", adapters[0]);
    const after = useSchematicStore.getState();
    expect(after.pendingPortEditConflicts).toBeNull();
    expect(after.pendingIncompatibleConnection).toBeNull();
    expect(after.edges.find((e) => e.id === "e1")).toBeUndefined();
    const adapterNode = after.nodes.find(
      (n) => n.type === "device" && n.id !== "n1" && n.id !== "n2",
    );
    expect(adapterNode).toBeDefined();
    const legs = after.edges.filter((e) => e.source === adapterNode!.id || e.target === adapterNode!.id);
    expect(legs).toHaveLength(2);
  });

  it("adapter insertion on a passthrough conflict bridges the face connectors", () => {
    // Front jack edited hdmi→bnc against an HDMI display; the adapter's BNC end must
    // land on the panel side and both legs must come out genuinely compatible.
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    useSchematicStore.setState({
      nodes: [pp, display],
      edges: [edge("e1", "pp", "p1-front", "n2", "in1")],
    });
    const state = useSchematicStore.getState();
    state.updateDevice("pp", {
      ...pp.data,
      ports: pp.data.ports.map((p) => (p.id === "p1" ? { ...p, frontConnectorType: "bnc" as const } : p)),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(1);

    const bridging: DeviceTemplate = {
      deviceType: "adapter",
      label: "BNC to HDMI Bridge",
      ports: [
        { id: "a-in", label: "In", signalType: "hdmi", direction: "input", connectorType: "bnc" },
        { id: "a-out", label: "Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
      ],
    };
    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", bridging);
    const after = useSchematicStore.getState();
    expect(after.pendingIncompatibleConnection).toBeNull();
    expect(after.edges.find((e) => e.id === "e1")).toBeUndefined();
    const legs = after.edges;
    expect(legs).toHaveLength(2);
    // Neither leg is a mismatch: bnc front → bnc in, hdmi out → hdmi in
    expect(legs.every((e) => !e.data?.connectorMismatch)).toBe(true);
    expect(legs.find((e) => e.source === "pp")?.sourceHandle).toBe("p1-front");
  });

  it("adapter legs that do not mate with the face connector are flagged", () => {
    // Same conflict, but the chosen adapter is HDMI on both ends — the panel-side leg
    // still meets a BNC jack, so it must render as a known mismatch, not clean.
    const pp = panel("pp", "hdmi");
    const display = device("n2", [port("in1", { direction: "input" })], 400);
    useSchematicStore.setState({
      nodes: [pp, display],
      edges: [edge("e1", "pp", "p1-front", "n2", "in1")],
    });
    const state = useSchematicStore.getState();
    state.updateDevice("pp", {
      ...pp.data,
      ports: pp.data.ports.map((p) => (p.id === "p1" ? { ...p, frontConnectorType: "bnc" as const } : p)),
    });
    const repeater: DeviceTemplate = {
      deviceType: "adapter",
      label: "HDMI Repeater",
      ports: [
        { id: "r-in", label: "In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
        { id: "r-out", label: "Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
      ],
    };
    useSchematicStore.getState().resolvePortEditConflict("e1", "adapter", repeater);
    const after = useSchematicStore.getState();
    const panelLeg = after.edges.find((e) => e.source === "pp");
    const displayLeg = after.edges.find((e) => e.target === "n2");
    expect(panelLeg?.data?.connectorMismatch).toBe(true);
    expect(displayLeg?.data?.connectorMismatch).toBeUndefined();
  });

  it("resolveAll keep flags every conflicted connection at once", () => {
    const player = device("n1", [port("out1"), port("out2")]);
    const display = device("n2", [port("in1", { direction: "input" }), port("in2", { direction: "input" })], 400);
    useSchematicStore.setState({
      nodes: [player, display],
      edges: [
        edge("e1", "n1", "out1", "n2", "in1"),
        edge("e2", "n1", "out2", "n2", "in2"),
      ],
    });
    const state = useSchematicStore.getState();
    state.updateDevice("n2", {
      ...display.data,
      ports: display.data.ports.map((p) => ({ ...p, signalType: "analog-audio" as const, connectorType: "xlr-3" as const })),
    });
    expect(useSchematicStore.getState().pendingPortEditConflicts).toHaveLength(2);

    useSchematicStore.getState().resolveAllPortEditConflicts("keep");
    const after = useSchematicStore.getState();
    expect(after.pendingPortEditConflicts).toBeNull();
    expect(after.edges.every((e) => e.data?.connectorMismatch === true)).toBe(true);
  });
});
