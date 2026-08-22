/**
 * #270 — a cable tag that prints the cable ID and nothing else.
 *
 * A stub always named the far end ("→ PROJECTOR [HDMI In 1]"), which is exactly the
 * information a user labelling a physical cable does not want on the drawing. The tag
 * now carries a per-stub `labelMode`: "full" (the default, and what every schematic
 * saved before this reads back as) or "cableId".
 *
 * The mode is honored inside buildStubLabelText — the one place canvas, PDF and DXF all
 * compose stub text — so none of the three can drift from the others.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { resolveStubLabelParts } from "../stubLabelResolve";
import { MISSING_CABLE_ID, buildStubLabelText, type StubLabelParts } from "../stubLabelText";
import { DEFAULT_STUB_LABEL_MODE } from "../types";
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
  // cableIdMap is derived state the app rebuilds from an effect, so newSchematic leaves
  // it alone — clear it here or one case's map decides the next case's cable IDs.
  useSchematicStore.setState({ toasts: [], cableIdMap: {} });
});

const parts = (over: Partial<StubLabelParts> = {}): StubLabelParts => ({
  arrow: "→",
  farLabel: "Projector",
  farPort: "HDMI In 1",
  farRoom: "Main Hall",
  myPage: "1",
  farPage: "3",
  cableId: "HDMI-001",
  ...over,
});

const everythingOn = {
  showArrow: true,
  showPort: true,
  showRoom: true,
  pageMode: "always",
} as const;

describe("cable-ID-only stub tags (#270)", () => {
  it("prints the cable ID alone, with every other content option turned on", () => {
    expect(buildStubLabelText(parts(), { ...everythingOn, labelMode: "cableId" }))
      .toBe("HDMI-001");
  });

  it("leaves the full label untouched in the default mode", () => {
    const full = "→ Projector [HDMI In 1] (Main Hall) Pg 3";
    expect(DEFAULT_STUB_LABEL_MODE).toBe("full");
    // Unset (every pre-#270 schematic), explicitly "full", and the exported default all
    // have to compose identically — this is the back-compatibility guarantee.
    expect(buildStubLabelText(parts(), everythingOn)).toBe(full);
    expect(buildStubLabelText(parts(), { ...everythingOn, labelMode: "full" })).toBe(full);
    expect(buildStubLabelText(parts(), { ...everythingOn, labelMode: DEFAULT_STUB_LABEL_MODE }))
      .toBe(full);
  });

  it("names no device even when the far end resolves to one", () => {
    const t = buildStubLabelText(parts(), { ...everythingOn, labelMode: "cableId" });
    expect(t).not.toContain("Projector");
    expect(t).not.toContain("Main Hall");
    expect(t).not.toContain("HDMI In 1");
    expect(t).not.toContain("Pg");
    expect(t).not.toContain("→");
  });

  // A direct-attach connection never gets a cable ID (computeCableSchedule skips it) and
  // can still be stubbed, so this state is reachable. Falling back to the device name
  // would defeat the whole point of the mode; an empty string would draw a blank box with
  // nothing to explain it, so the tag carries the same "—" the patch-panel report uses.
  it("marks an unnumbered cable rather than falling back to the device", () => {
    expect(buildStubLabelText(parts({ cableId: "" }), { ...everythingOn, labelMode: "cableId" }))
      .toBe(MISSING_CABLE_ID);
    expect(MISSING_CABLE_ID.trim()).not.toBe("");
    expect(buildStubLabelText(parts({ cableId: "" }), { ...everythingOn, labelMode: "cableId" }))
      .not.toContain("Projector");
  });
});

/**
 * SRC-DEV ──▶ PROJECTOR, stubbed at both ends. convertEdgeToStubs strips cableId from the
 * target-side leg, so the two tags reach the ID by different routes.
 */
function seedStubbedRun() {
  const nodes: SchematicNode[] = [
    { id: "room-hall", type: "room", position: { x: 800, y: 0 },
      style: { width: 400, height: 300 },
      data: { label: "Main Hall" } } as unknown as SchematicNode,
    { id: "dev-src", type: "device", position: { x: 0, y: 100 },
      measured: { width: 144, height: 48 },
      data: { label: "MATRIX", deviceType: "misc", ports: [
        { id: "hdmi-out-1", label: "HDMI Out 1", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
      ] } } as unknown as SchematicNode,
    { id: "dev-proj", type: "device", position: { x: 100, y: 100 }, parentId: "room-hall",
      measured: { width: 144, height: 48 },
      data: { label: "PROJECTOR", deviceType: "display", ports: [
        { id: "hdmi-in-1", label: "HDMI In 1", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
      ] } } as unknown as SchematicNode,
  ];
  const edges: ConnectionEdge[] = [
    { id: "e-run", source: "dev-src", sourceHandle: "hdmi-out-1",
      target: "dev-proj", targetHandle: "hdmi-in-1",
      data: { signalType: "hdmi", cableId: "HDMI-001" } } as unknown as ConnectionEdge,
  ];
  useSchematicStore.setState({ nodes, edges });
  useSchematicStore.getState().convertEdgeToStubs("e-run");
}

/** What StubLabelNode's label selector resolves for one tag. */
function tagParts(tagId: string) {
  const s = useSchematicStore.getState();
  const tag = s.nodes.find((n) => n.id === tagId)!;
  return resolveStubLabelParts(tagId, tag.data as StubLabelData, {
    nodes: s.nodes,
    edges: s.edges,
    cableIdMap: s.cableIdMap,
  });
}

describe("resolving the cable ID a tag prints (#270)", () => {
  it("reaches it from BOTH ends, though only the source leg stores it", () => {
    seedStubbedRun();
    const legs = useSchematicStore.getState().edges;
    // Guard the premise: the target-side leg genuinely has no cableId of its own.
    expect(legs.find((e) => e.id === "e-run-tgt")?.data?.cableId).toBeUndefined();
    expect(tagParts("stub-e-run-src")?.cableId).toBe("HDMI-001");
    expect(tagParts("stub-e-run-tgt")?.cableId).toBe("HDMI-001");
  });

  it("prefers the store's map, so the tag agrees with the ID drawn on the leg", () => {
    seedStubbedRun();
    useSchematicStore.setState({ cableIdMap: { "e-run-src": "HDMI-042", "e-run-tgt": "HDMI-042" } });
    expect(tagParts("stub-e-run-src")?.cableId).toBe("HDMI-042");
    expect(tagParts("stub-e-run-tgt")?.cableId).toBe("HDMI-042");
  });

  it("composes to the cable ID on the canvas path once the mode is set", () => {
    seedStubbedRun();
    useSchematicStore.getState().patchStubLabelData("stub-e-run-src", { labelMode: "cableId" });
    const store = useSchematicStore.getState();
    const tag = store.nodes.find((n) => n.id === "stub-e-run-src")!;
    const data = tag.data as StubLabelData;
    const resolved = tagParts("stub-e-run-src")!;
    expect(buildStubLabelText(resolved, { ...everythingOn, labelMode: data.labelMode }))
      .toBe("HDMI-001");
    // The partner tag was not touched and still names the destination.
    const partner = store.nodes.find((n) => n.id === "stub-e-run-tgt")!;
    expect((partner.data as StubLabelData).labelMode).toBeUndefined();
    expect(buildStubLabelText(tagParts("stub-e-run-tgt")!, {
      ...everythingOn,
      labelMode: (partner.data as StubLabelData).labelMode,
    })).toContain("MATRIX");
  });
});

describe("the mode survives a save/load round-trip (#270)", () => {
  it("comes back on the same tag after export and re-import", () => {
    seedStubbedRun();
    useSchematicStore.getState().patchStubLabelData("stub-e-run-src", { labelMode: "cableId" });

    const saved = JSON.parse(JSON.stringify(useSchematicStore.getState().exportToJSON()));
    useSchematicStore.getState().newSchematic();
    expect(useSchematicStore.getState().nodes.find((n) => n.id === "stub-e-run-src")).toBeUndefined();

    useSchematicStore.getState().importFromJSON(saved);
    const reloaded = useSchematicStore.getState().nodes;
    expect((reloaded.find((n) => n.id === "stub-e-run-src")!.data as StubLabelData).labelMode)
      .toBe("cableId");
    // Untouched tags stay unset, so they keep following the default rather than being
    // stamped "full" on the way through the file.
    expect((reloaded.find((n) => n.id === "stub-e-run-tgt")!.data as StubLabelData).labelMode)
      .toBeUndefined();
  });

  it("clears back to the default and stays cleared across a round-trip", () => {
    seedStubbedRun();
    useSchematicStore.getState().patchStubLabelData("stub-e-run-src", { labelMode: "cableId" });
    useSchematicStore.getState().patchStubLabelData("stub-e-run-src", { labelMode: undefined });

    const saved = JSON.parse(JSON.stringify(useSchematicStore.getState().exportToJSON()));
    useSchematicStore.getState().newSchematic();
    useSchematicStore.getState().importFromJSON(saved);

    const tag = useSchematicStore.getState().nodes.find((n) => n.id === "stub-e-run-src")!;
    expect((tag.data as StubLabelData).labelMode).toBeUndefined();
    expect(buildStubLabelText(tagParts("stub-e-run-src")!, {
      ...everythingOn,
      labelMode: (tag.data as StubLabelData).labelMode,
    })).toBe("→ PROJECTOR [HDMI In 1] (Main Hall)");
  });
});
