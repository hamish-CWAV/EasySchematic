// The label-case preference is display-only — stored data is never mutated, and the
// tests in roomLabelCase/stubLabelCase pin that. The cable-schedule CSV used to leak
// around that invariant (#309): export wrote the RENDERED text, and csvImport read it
// back as data, so an UPPERCASE export re-imported as rooms and devices genuinely
// NAMED in uppercase. The CSV now carries raw stored names (computeCableScheduleForCsv)
// and may legitimately differ from on-screen casing; this file pins the round trip.

import { describe, it, expect, afterEach } from "vitest";
import { computeCableSchedule, computeCableScheduleForCsv, buildCableScheduleCsv } from "../cableSchedule";
import { parseCsv, extractConnections, matchDevices, buildImportResult, type ColumnMapping } from "../csvImport";
import { transformLabelNow, withRawLabels } from "../labelCaseUtils";
import { makeDevice, makeEdge, makePort } from "../routingHarness/fixtures";
import { useSchematicStore } from "../store";
import type { LabelCaseMode, SchematicNode, ConnectionEdge, DeviceNode, RoomData } from "../types";

const NON_AS_TYPED: LabelCaseMode[] = ["uppercase", "lowercase", "capitalize"];

/** One HDMI cable between two devices in a room, every label mixed-case on purpose
 *  so any mode's transform would visibly change it. */
function scene(): { nodes: SchematicNode[]; edges: ConnectionEdge[] } {
  const room = {
    id: "r1", type: "room", position: { x: 0, y: 0 }, data: { label: "main Hall" },
  } as unknown as SchematicNode;
  const out = makePort("hdmi out 1", "hdmi", "output");
  const inp = makePort("hdmi in A", "hdmi", "input");
  const src = makeDevice({ id: "d1", label: "cam ONE", x: 0, y: 0, ports: [out], parentId: "r1" });
  const tgt = makeDevice({ id: "d2", label: "Vision MIXER", x: 700, y: 0, ports: [inp], parentId: "r1" });
  const edge = makeEdge({
    id: "e1", source: "d1", sourceHandle: out.id, target: "d2", targetHandle: inp.id,
    signalType: "hdmi",
  });
  return { nodes: [room, src, tgt], edges: [edge] };
}

/** Same cable, but the target sits in a subroom: "FOH mix" nested inside
 *  "main Sanctuary". Pins the room-path round trip (#324) — the CSV must carry
 *  the " > " path syntax csvImport parses, not the on-screen " - " join. */
function nestedScene(): { nodes: SchematicNode[]; edges: ConnectionEdge[] } {
  const sanctuary = {
    id: "r1", type: "room", position: { x: 0, y: 0 }, data: { label: "main Sanctuary" },
  } as unknown as SchematicNode;
  const foh = {
    id: "r2", type: "room", position: { x: 0, y: 0 }, parentId: "r1", data: { label: "FOH mix" },
  } as unknown as SchematicNode;
  const out = makePort("hdmi out 1", "hdmi", "output");
  const inp = makePort("hdmi in A", "hdmi", "input");
  const src = makeDevice({ id: "d1", label: "cam ONE", x: 0, y: 0, ports: [out], parentId: "r1" });
  const tgt = makeDevice({ id: "d2", label: "Vision MIXER", x: 700, y: 0, ports: [inp], parentId: "r2" });
  const edge = makeEdge({
    id: "e1", source: "d1", sourceHandle: out.id, target: "d2", targetHandle: inp.id,
    signalType: "hdmi",
  });
  return { nodes: [sanctuary, foh, src, tgt], edges: [edge] };
}

/** Map the export's own header names explicitly, as a user does in the import wizard.
 *  (Auto-detection is detectColumns's concern, not this round trip's.) */
function mappingFor(headers: string[]): ColumnMapping {
  return {
    sourceDevice: headers.indexOf("Source"),
    sourcePort: headers.indexOf("Src Port"),
    destDevice: headers.indexOf("Target"),
    destPort: headers.indexOf("Tgt Port"),
    signalType: headers.indexOf("Signal"),
    sourceRoom: headers.indexOf("Src Room"),
    destRoom: headers.indexOf("Tgt Room"),
  };
}

/** Export under the current preference and run the file back through the import
 *  pipeline. The title/date preamble is dropped first, as a user trimming the file
 *  for the wizard would. */
function roundTrip(nodes: SchematicNode[], edges: ConnectionEdge[]) {
  const rows = computeCableScheduleForCsv(nodes, edges);
  const csv = buildCableScheduleCsv(rows, "Round Trip", "2026-01-01");
  const parsed = parseCsv(csv.split("\n").slice(3).join("\n"));
  const connections = extractConnections(parsed.rows, mappingFor(parsed.headers));
  return { csv, connections, ...buildImportResult(connections, matchDevices(connections, [])) };
}

afterEach(() => {
  useSchematicStore.setState({ labelCase: "as-typed" });
});

describe("cable-schedule CSV round trip (#309)", () => {
  it("exports the stored names, not the rendered case, in every mode", () => {
    const { nodes, edges } = scene();
    for (const mode of NON_AS_TYPED) {
      useSchematicStore.setState({ labelCase: mode });
      const csv = buildCableScheduleCsv(computeCableScheduleForCsv(nodes, edges), "Round Trip", "2026-01-01");
      expect(csv).toContain("cam ONE");
      expect(csv).toContain("Vision MIXER");
      expect(csv).toContain("main Hall");
      expect(csv).toContain("hdmi out 1");
      expect(csv).not.toContain("CAM ONE");
      expect(csv).not.toContain("MAIN HALL");
    }
  });

  it("re-importing an export leaves device, room, and port names unchanged", () => {
    const { nodes, edges } = scene();
    for (const mode of NON_AS_TYPED) {
      useSchematicStore.setState({ labelCase: mode });
      const result = roundTrip(nodes, edges);

      const devices = result.nodes.filter((n) => n.type === "device") as DeviceNode[];
      expect(devices.map((d) => d.data.label).sort()).toEqual(["Vision MIXER", "cam ONE"]);

      const rooms = result.nodes.filter((n) => n.type === "room");
      expect(rooms.map((r) => (r.data as RoomData).label)).toEqual(["main Hall"]);

      const cam = devices.find((d) => d.data.label === "cam ONE")!;
      expect(cam.data.ports.map((p) => p.label)).toEqual(["hdmi out 1"]);
    }
  });

  it("exports subroom paths in the importer's ' > ' syntax, not the display join (#324)", () => {
    const { nodes, edges } = nestedScene();
    for (const mode of ["as-typed", ...NON_AS_TYPED] as LabelCaseMode[]) {
      useSchematicStore.setState({ labelCase: mode });
      const csv = buildCableScheduleCsv(computeCableScheduleForCsv(nodes, edges), "Round Trip", "2026-01-01");
      expect(csv).toContain("main Sanctuary > FOH mix");
      expect(csv).not.toContain("main Sanctuary - FOH mix");
    }
  });

  it("re-importing an export recreates the subroom nesting with names intact", () => {
    const { nodes, edges } = nestedScene();
    for (const mode of ["as-typed", ...NON_AS_TYPED] as LabelCaseMode[]) {
      useSchematicStore.setState({ labelCase: mode });
      const result = roundTrip(nodes, edges);

      const rooms = result.nodes.filter((n) => n.type === "room");
      expect(rooms.map((r) => (r.data as RoomData).label).sort()).toEqual(["FOH mix", "main Sanctuary"]);

      const sanctuary = rooms.find((r) => (r.data as RoomData).label === "main Sanctuary")!;
      const foh = rooms.find((r) => (r.data as RoomData).label === "FOH mix")!;
      expect(sanctuary.parentId).toBeUndefined();
      expect(foh.parentId).toBe(sanctuary.id);

      const devices = result.nodes.filter((n) => n.type === "device") as DeviceNode[];
      expect(devices.find((d) => d.data.label === "cam ONE")!.parentId).toBe(sanctuary.id);
      expect(devices.find((d) => d.data.label === "Vision MIXER")!.parentId).toBe(foh.id);
    }
  });

  it("the on-screen rows still follow the display case — only the CSV goes raw", () => {
    const { nodes, edges } = scene();
    useSchematicStore.setState({ labelCase: "uppercase" });
    const [row] = computeCableSchedule(nodes, edges);
    expect(row.sourceDevice).toBe("CAM ONE");
    expect(row.sourceRoom).toBe("MAIN HALL");
    expect(row.sourcePort).toBe("HDMI OUT 1");

    useSchematicStore.setState({ labelCase: "as-typed" });
    const sub = nestedScene();
    const [nested] = computeCableSchedule(sub.nodes, sub.edges);
    expect(nested.targetRoom).toBe("main Sanctuary - FOH mix");
  });

  it("withRawLabels restores the transform afterwards, even on throw", () => {
    useSchematicStore.setState({ labelCase: "uppercase" });
    expect(withRawLabels(() => transformLabelNow("cam ONE"))).toBe("cam ONE");
    expect(transformLabelNow("cam ONE")).toBe("CAM ONE");
    expect(() => withRawLabels(() => { throw new Error("boom"); })).toThrow("boom");
    expect(transformLabelNow("cam ONE")).toBe("CAM ONE");
  });
});
