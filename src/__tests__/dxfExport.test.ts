import { afterEach, describe, expect, it } from "vitest";
import DxfParser from "dxf-parser";
import type { ReactFlowInstance } from "@xyflow/react";

import type { AuxRow, ConnectionEdge, LabelCaseMode, SchematicNode } from "../types";
import { DEFAULT_LABEL_CASE } from "../types";
import { useSchematicStore } from "../store";
import { DxfWriter } from "../dxfExport/writer";
import { buildDxf } from "../dxfExport";
import { emitAnnotation, emitDevice, emitRoom } from "../dxfExport/nodes";
import { emitLegend } from "../dxfExport/legend";
import {
  CAP_HEIGHT_RATIO,
  DPI,
  cssFontPxToDxfHeight,
  escapeForMText,
  escapeForText,
  fmt,
  hexToRgb,
  rgbToTrueColor,
  sanitizeName,
  tintToWhite,
  truncateToWidth,
} from "../dxfExport/units";
import { CANONICAL_LAYERS, LTYPE_DEFS, buildLayerDefs, signalLayerName } from "../dxfExport/layers";
import { emitRoundedWaypointPath } from "../dxfExport/geometry";
import type { RoutedEdge } from "../edgeRouter";

/** Build a minimum-viable DXF document with the given entities inside ENTITIES. */
function buildMinimalDxf(
  emit: (writer: DxfWriter) => void,
): string {
  const w = new DxfWriter();
  w.setExtents({ x: 0, y: 0 }, { x: 10, y: 10 });
  w.writeHeader();
  w.writeClasses();
  w.writeTables(
    [
      { name: "0", color: 7 },
      { name: "TEST", color: 7 },
    ],
    LTYPE_DEFS,
  );
  w.writeBlocks();
  w.startEntities();
  emit(w);
  w.endEntities();
  w.writeObjects();
  w.writeEof();
  return w.toString();
}

// dxf-parser's types are stricter than its runtime behavior — cast to any so
// we can access entity-specific fields without narrowing every read site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(dxfString: string): any {
  const parser = new DxfParser();
  return parser.parseSync(dxfString);
}

/** A single horizontal run, the shape the router produces for a straight hop. */
function straightRoute(x1: number, y: number, x2: number) {
  return {
    segments: [{ x1, y1: y, x2, y2: y, axis: "h" }],
    waypoints: [{ x: x1, y }, { x: x2, y }],
    crossingPoints: [],
    labelX: (x1 + x2) / 2,
    labelY: y,
  } as unknown as RoutedEdge;
}

/** ReactFlowInstance stand-in over a fixed node list — the exporter only reads
 *  positionAbsolute and handleBounds. */
function instanceFor(nodes: SchematicNode[]): ReactFlowInstance {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  return {
    getInternalNode: (id: string) => {
      const n = byId.get(id);
      if (!n) return undefined;
      return {
        internals: {
          positionAbsolute: { x: n.position.x, y: n.position.y },
          handleBounds: { source: [], target: [] },
        },
      };
    },
  } as unknown as ReactFlowInstance;
}

interface RawEntity { type: string; layer: string; pairs: [string, string][] }

/** Every entity in the ENTITIES section, in emission order, walking the (group code,
 *  value) pairs directly. dxf-parser normalizes and reorders what it keeps, so anything
 *  asserting about raw group codes — or about where a fill sits relative to the text it
 *  masks — has to read the stream itself. */
function rawEntityStream(dxf: string): RawEntity[] {
  const lines = dxf.split("\r\n");
  const out: RawEntity[] = [];
  let inEntities = false;
  let current: RawEntity | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i];
    const value = lines[i + 1];
    if (code === "0") {
      if (value === "ENDSEC") inEntities = false;
      current = null;
      if (inEntities && value !== "SECTION") {
        current = { type: value, layer: "", pairs: [] };
        out.push(current);
      }
    } else if (code === "2" && value === "ENTITIES") {
      inEntities = true;
    } else if (current) {
      if (code === "8" && !current.layer) current.layer = value;
      current.pairs.push([code, value]);
    }
  }
  return out;
}

/** The four corners of a SOLID, in DXF group order (10/11/12/13). */
function solidCorners(e: RawEntity): { x: number; y: number }[] {
  const byCode = new Map(e.pairs.map(([code, value]) => [code, Number(value)]));
  return ["10", "11", "12", "13"].map((code, i) => ({
    x: byCode.get(code)!,
    y: byCode.get(String(20 + i))!,
  }));
}

/** Bounding box (DXF inches) of an opaque mask — a SOLID quad. */
function maskBounds(e: RawEntity): { x1: number; y1: number; x2: number; y2: number } {
  const corners = solidCorners(e);
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** Drop the schematic the whole-document tests loaded into the store. */
function resetExportStore() {
  useSchematicStore.setState({
    nodes: [], edges: [], routedEdges: {}, labelCase: DEFAULT_LABEL_CASE,
    cableIdLabelMode: "endpoint", cableIdGap: 4, cableIdMidOffset: 0,
  });
}

describe("units helpers", () => {
  it("sanitizes layer names, keeping only legal DXF chars", () => {
    expect(sanitizeName("analog-audio")).toBe("ANALOG-AUDIO");
    expect(sanitizeName("power l1")).toBe("POWER_L1");
    expect(sanitizeName("hdmi")).toBe("HDMI");
    // Runs of unsupported chars collapse to a single underscore
    expect(sanitizeName("foo   bar")).toBe("FOO_BAR");
    // Leading/trailing underscores (from invalid chars) get stripped
    expect(sanitizeName("!!!weird!!!")).toBe("WEIRD");
  });

  it("converts hex colors to RGB and packs true-color ints", () => {
    expect(hexToRgb("#ff0000")).toEqual([0xff, 0, 0]);
    expect(hexToRgb("#2563eb")).toEqual([0x25, 0x63, 0xeb]);
    expect(rgbToTrueColor(0xff, 0, 0)).toBe(0xff0000);
    expect(rgbToTrueColor(0x25, 0x63, 0xeb)).toBe(0x2563eb);
  });

  it("tints colors toward white", () => {
    expect(tintToWhite("#000000", 1)).toBe("#ffffff");
    expect(tintToWhite("#000000", 0)).toBe("#000000");
    const mid = tintToWhite("#000000", 0.5);
    expect(mid).toMatch(/^#[78][0-9a-f]{5}$/);
  });

  it("escapes non-ASCII to \\U+XXXX and preserves ASCII", () => {
    expect(escapeForText("Audio")).toBe("Audio");
    expect(escapeForText("\u2192")).toBe("\\U+2192"); // right arrow
    expect(escapeForText("\u00b1")).toBe("\\U+00B1"); // plus-minus
    expect(escapeForText("a\\b")).toBe("a\\\\b");
  });

  it("escapes MText-specific characters", () => {
    expect(escapeForMText("{group}")).toBe("\\{group\\}");
    expect(escapeForMText("x\\y")).toBe("x\\\\y");
  });

  it("formats numbers cleanly", () => {
    expect(fmt(1)).toBe("1");
    expect(fmt(1.0)).toBe("1");
    expect(fmt(1.23456789)).toBe("1.234568");
    expect(fmt(0.0000001)).toBe("0");
    expect(fmt(NaN)).toBe("0");
  });
});

describe("layers helpers", () => {
  it("builds layer list with all canonical layers + one per signal type", () => {
    const sigs = new Set(["hdmi", "sdi"] as const);
    const layers = buildLayerDefs(sigs as Set<never>, undefined);
    const names = layers.map((l) => l.name);
    expect(names).toContain("0");
    expect(names).toContain("EasySchematic-Rooms");
    expect(names).toContain("EasySchematic-Rooms-Fill");
    expect(names).toContain("EasySchematic-Devices");
    expect(names).toContain("EasySchematic-Connections-HDMI");
    expect(names).toContain("EasySchematic-Connections-SDI");
  });

  it("sanitizes signal layer names — never spaces", () => {
    expect(signalLayerName("analog-audio")).toBe("EasySchematic-Connections-ANALOG-AUDIO");
    expect(signalLayerName("power-l1")).toBe("EasySchematic-Connections-POWER-L1");
    expect(signalLayerName("s-video")).toBe("EasySchematic-Connections-S-VIDEO");
    for (const sig of ["analog-audio", "power-l1", "s-video"] as const) {
      expect(signalLayerName(sig)).not.toContain(" ");
    }
  });
});

describe("DxfWriter — structural", () => {
  it("produces a DXF that dxf-parser can read without errors", () => {
    const dxf = buildMinimalDxf(() => {
      // No entities — just exercise the header/tables/blocks/objects.
    });
    const parsed = parse(dxf);
    expect(parsed).toBeTruthy();
    expect(parsed.header).toBeTruthy();
    expect(parsed.header.$ACADVER).toBe("AC1015");
    expect(parsed.header.$INSUNITS).toBe(1);
    expect(parsed.tables.layer).toBeTruthy();
    expect(parsed.tables.lineType).toBeTruthy();
  });

  it("declares inches via $INSUNITS=1 and emits $MEASUREMENT=0", () => {
    const dxf = buildMinimalDxf(() => {});
    const parsed = parse(dxf);
    expect(parsed.header.$INSUNITS).toBe(1);
    expect(parsed.header.$MEASUREMENT).toBe(0);
  });

  it("includes all standard tables required by AutoCAD", () => {
    const dxf = buildMinimalDxf(() => {});
    const parsed = parse(dxf);
    // dxf-parser exposes layer, lineType, viewPort (STYLE/APPID/etc. are
    // present in the file but not reflected in the parser's top-level tables)
    expect(Object.keys(parsed.tables)).toEqual(
      expect.arrayContaining(["layer", "lineType", "viewPort"]),
    );
    // Confirm STYLE and BLOCK_RECORD tables are in the raw output
    expect(dxf).toMatch(/\r?\nSTYLE\r?\n/);
    expect(dxf).toMatch(/\r?\nBLOCK_RECORD\r?\n/);
    expect(dxf).toMatch(/\r?\nVPORT\r?\n/);
  });

  it("emits all configured layers with correct colors", () => {
    const dxf = buildMinimalDxf(() => {});
    const parsed = parse(dxf);
    const layerNames = Object.keys(parsed.tables.layer.layers);
    expect(layerNames).toContain("0");
    expect(layerNames).toContain("TEST");
  });

  it("LINE entity appears in ENTITIES with correct endpoints", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addLine("0", 0, 0, 5, 3);
    });
    const parsed = parse(dxf);
    const lines = parsed.entities.filter((e: { type: string }) => e.type === "LINE");
    expect(lines.length).toBe(1);
    const line = lines[0] as { vertices: { x: number; y: number }[] };
    expect(line.vertices[0].x).toBeCloseTo(0);
    expect(line.vertices[0].y).toBeCloseTo(0);
    expect(line.vertices[1].x).toBeCloseTo(5);
    expect(line.vertices[1].y).toBeCloseTo(3);
  });

  it("LWPOLYLINE rect has 4 vertices and closed flag", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addRect("0", 0, 0, 10, 5);
    });
    const parsed = parse(dxf);
    const polys = parsed.entities.filter((e: { type: string }) => e.type === "LWPOLYLINE");
    expect(polys.length).toBe(1);
    const poly = polys[0] as { vertices: { x: number; y: number }[]; shape: boolean };
    expect(poly.vertices.length).toBe(4);
    expect(poly.shape).toBe(true); // closed
  });

  it("TEXT entity is emitted with escaped non-ASCII content", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addText("0", 1, 1, "Arrow \u2192 target", { height: 0.1 });
    });
    expect(dxf).toContain("Arrow \\U+2192 target");
    const parsed = parse(dxf);
    const texts = parsed.entities.filter((e: { type: string }) => e.type === "TEXT");
    expect(texts.length).toBe(1);
  });

  it("ARC entity has correct center, radius, and angles", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addArc("0", 2, 3, 0.5, 0, 180);
    });
    const parsed = parse(dxf);
    const arcs = parsed.entities.filter((e: { type: string }) => e.type === "ARC");
    expect(arcs.length).toBe(1);
    const arc = arcs[0] as { center: { x: number; y: number }; radius: number };
    expect(arc.center.x).toBeCloseTo(2);
    expect(arc.center.y).toBeCloseTo(3);
    expect(arc.radius).toBeCloseTo(0.5);
  });

  it("ELLIPSE entity has correct center and ratio", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addEllipse("0", 5, 5, 3, 0, 0.5);
    });
    const parsed = parse(dxf);
    const ellipses = parsed.entities.filter((e: { type: string }) => e.type === "ELLIPSE");
    expect(ellipses.length).toBe(1);
    const ell = ellipses[0] as { center: { x: number; y: number }; axisRatio: number };
    expect(ell.center.x).toBeCloseTo(5);
    expect(ell.axisRatio).toBeCloseTo(0.5);
  });

  it("MTEXT with non-ASCII escapes survives parsing", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addMText("0", 0, 0, "\u00b14 dB", { height: 0.1 });
    });
    expect(dxf).toContain("\\U+00B1");
    const parsed = parse(dxf);
    const mts = parsed.entities.filter((e: { type: string }) => e.type === "MTEXT");
    expect(mts.length).toBe(1);
  });

  it("mixes entities on multiple layers correctly", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addLine("0", 0, 0, 1, 0);
      w.addLine("TEST", 0, 1, 1, 1);
      w.addRect("TEST", 0, 2, 1, 1);
    });
    const parsed = parse(dxf);
    const entities = parsed.entities as { layer: string; type: string }[];
    const onTest = entities.filter((e) => e.layer === "TEST");
    expect(onTest.length).toBe(2);
    const onZero = entities.filter((e) => e.layer === "0");
    expect(onZero.length).toBe(1);
  });

  it("emits true-color (group 420) when set on entity style", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addLine("0", 0, 0, 1, 0, { trueColor: 0xff0000 });
    });
    // Group code 420 with the packed color value should appear in output
    expect(dxf).toMatch(/\b420\r?\n\s*16711680/);
    const parsed = parse(dxf);
    expect(parsed.entities.length).toBe(1);
  });

  it("linetype definitions are present in tables", () => {
    const dxf = buildMinimalDxf(() => {});
    const parsed = parse(dxf);
    const ltypeNames = Object.keys(parsed.tables.lineType.lineTypes);
    expect(ltypeNames).toContain("CONTINUOUS");
    expect(ltypeNames).toContain("ES_DASHED");
    expect(ltypeNames).toContain("ES_DOTTED");
    expect(ltypeNames).toContain("ES_DASHDOT");
    expect(ltypeNames).toContain("ES_MISMATCH");
  });

  it("writes extents that parse as numeric values", () => {
    const w = new DxfWriter();
    w.setExtents({ x: -1.5, y: -2.5 }, { x: 10.25, y: 8.75 });
    w.writeHeader();
    w.writeClasses();
    w.writeTables([{ name: "0", color: 7 }], LTYPE_DEFS);
    w.writeBlocks();
    w.startEntities();
    w.endEntities();
    w.writeObjects();
    w.writeEof();
    const parsed = parse(w.toString());
    expect(parsed.header.$EXTMIN.x).toBeCloseTo(-1.5);
    expect(parsed.header.$EXTMIN.y).toBeCloseTo(-2.5);
    expect(parsed.header.$EXTMAX.x).toBeCloseTo(10.25);
    expect(parsed.header.$EXTMAX.y).toBeCloseTo(8.75);
  });

  it("produces output that starts with a SECTION and ends with EOF", () => {
    const dxf = buildMinimalDxf(() => {});
    const trimmed = dxf.trim();
    expect(trimmed.startsWith("0")).toBe(true);
    expect(trimmed.endsWith("EOF")).toBe(true);
    // Every section should have a matching ENDSEC
    const sectionCount = (trimmed.match(/\r?\nSECTION\r?\n/g) ?? []).length;
    const endsecCount = (trimmed.match(/\r?\nENDSEC\r?\n/g) ?? []).length;
    expect(sectionCount).toBe(endsecCount);
    expect(sectionCount).toBeGreaterThanOrEqual(6); // HEADER, CLASSES, TABLES, BLOCKS, ENTITIES, OBJECTS
  });
});

describe("visual-fidelity follow-up", () => {
  it("text heights use cap-height ratio (10px CSS → ~0.075\" DXF)", () => {
    expect(CAP_HEIGHT_RATIO).toBeLessThan(1);
    expect(CAP_HEIGHT_RATIO).toBeGreaterThan(0.5);
    const h10 = cssFontPxToDxfHeight(10);
    // 10 * 0.72 / 96 ≈ 0.075
    expect(h10).toBeCloseTo(10 * CAP_HEIGHT_RATIO / 96, 4);
  });

  it("addRoundedRect emits 8-vertex closed LWPOLYLINE with 4 bulges", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addRoundedRect("0", 0, 0, 10, 6, 0.5);
    });
    const parsed = parse(dxf);
    const polys = parsed.entities.filter((e: { type: string }) => e.type === "LWPOLYLINE");
    expect(polys.length).toBe(1);
    const poly = polys[0] as { vertices: { x: number; y: number; bulge?: number }[]; shape: boolean };
    expect(poly.shape).toBe(true);
    expect(poly.vertices.length).toBe(8);
    // 4 of the 8 vertices should have a non-zero bulge (one per fillet)
    const bulged = poly.vertices.filter((v) => v.bulge !== undefined && Math.abs(v.bulge) > 0.01);
    expect(bulged.length).toBe(4);
    // Bulge for a 90° arc is tan(π/8) ≈ 0.4142
    for (const v of bulged) {
      expect(v.bulge).toBeCloseTo(Math.tan(Math.PI / 8), 3);
    }
  });

  it("addRoundedRect with zero radius falls back to addRect", () => {
    const dxf = buildMinimalDxf((w) => {
      w.addRoundedRect("0", 0, 0, 10, 6, 0);
    });
    const parsed = parse(dxf);
    const polys = parsed.entities.filter((e: { type: string }) => e.type === "LWPOLYLINE");
    expect(polys.length).toBe(1);
    expect((polys[0] as { vertices: unknown[] }).vertices.length).toBe(4);
  });

  it("waypoint path with one 90° turn emits LINE + ARC + LINE", () => {
    const dxf = buildMinimalDxf((w) => {
      // Path: (0,0) → (100,0) → (100,50). Corner at (100, 0).
      emitRoundedWaypointPath(
        w,
        [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }],
        [], [],
        "0",
        {},
      );
    });
    const parsed = parse(dxf);
    const lines = parsed.entities.filter((e: { type: string }) => e.type === "LINE");
    const arcs = parsed.entities.filter((e: { type: string }) => e.type === "ARC");
    expect(lines.length).toBe(2);
    expect(arcs.length).toBe(1);
  });

  it("waypoint path with no interior corner emits a single LINE (no fillet)", () => {
    const dxf = buildMinimalDxf((w) => {
      emitRoundedWaypointPath(
        w,
        [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        [], [],
        "0",
        {},
      );
    });
    const parsed = parse(dxf);
    const lines = parsed.entities.filter((e: { type: string }) => e.type === "LINE");
    const arcs = parsed.entities.filter((e: { type: string }) => e.type === "ARC");
    expect(lines.length).toBe(1);
    expect(arcs.length).toBe(0);
  });

  it("waypoint path with a hop crossing emits hop arc + corner fillet", () => {
    const dxf = buildMinimalDxf((w) => {
      // Path: (0,0) → (200,0) → (200,100). Horizontal segment has a hop at (100,0).
      emitRoundedWaypointPath(
        w,
        [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }],
        [{ x: 100, y: 0 }],  // arc hop on horizontal segment
        [],
        "0",
        {},
      );
    });
    const parsed = parse(dxf);
    const arcs = parsed.entities.filter((e: { type: string }) => e.type === "ARC");
    // Expect at least 2 arcs: 1 hop + 1 corner fillet
    expect(arcs.length).toBeGreaterThanOrEqual(2);
  });

  it("truncateToWidth adds ellipsis when text exceeds maxWidth", () => {
    // Short text fits as-is.
    expect(truncateToWidth("short", 10, 0.1)).toBe("short");
    // Long text gets truncated and ends with "..."
    const result = truncateToWidth("This device name is way too long to fit", 0.5, 0.1);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThan("This device name is way too long to fit".length);
    // Empty input returns empty
    expect(truncateToWidth("", 5, 0.1)).toBe("");
    // Zero width returns empty
    expect(truncateToWidth("hello", 0, 0.1)).toBe("");
  });

  it("truncateToWidth keeps the result inside the requested maxWidth", () => {
    // Long label in a narrow box — after truncation, estimated width of
    // <prefix> + "..." must fit within the requested maxWidth.
    const height = 0.09; // ≈ 12px CSS label
    const maxWidth = 1.625; // 180px device minus px-3 padding
    const result = truncateToWidth(
      "BMD Micro Studio camera 4K G2 1",
      maxWidth,
      height,
    );
    expect(result.endsWith("...")).toBe(true);
    // Compute an independent width estimate with the same aspect assumptions.
    const charW = height * 0.65;
    const ellipsisW = height * 0.28 * 3;
    const prefixLen = result.length - 3; // strip "..."
    const estWidth = prefixLen * charW + ellipsisW;
    expect(estWidth).toBeLessThanOrEqual(maxWidth);
  });

  it("STYLE table primary font is arial.ttf (Inter-compatible)", () => {
    const dxf = buildMinimalDxf(() => {});
    expect(dxf).toContain("arial.ttf");
    // And not the blocky txt fallback
    const styleStart = dxf.indexOf("STANDARD");
    const styleEnd = dxf.indexOf("ENDTAB", styleStart);
    const styleBlock = dxf.substring(styleStart, styleEnd);
    expect(styleBlock).not.toMatch(/\r?\n\s*3\r?\n\s*txt\r?\n/);
  });
});

describe("emitDevice — header label placement", () => {
  const DEVICE_Y = 100;

  function deviceNode(label: string, auxiliaryData: AuxRow[] = []): SchematicNode {
    return {
      id: "n1",
      type: "device",
      position: { x: 0, y: DEVICE_Y },
      measured: { width: 144, height: 80 },
      data: {
        label,
        // Wrapping enabled per-instance so `wrapsInHeader` turns purely on whether
        // the name overflows the 144-px box.
        wrapLabel: true,
        auxiliaryData,
        ports: [
          { id: "p1", label: "In", direction: "input", signalType: "hdmi" },
          { id: "p2", label: "Out", direction: "output", signalType: "hdmi" },
        ],
      },
    } as unknown as SchematicNode;
  }

  /** Minimal ReactFlowInstance stand-in — emitDevice only reads positionAbsolute
   *  and handleBounds off the internal node. */
  function stubInstance(node: SchematicNode): ReactFlowInstance {
    return {
      getInternalNode: () => ({
        internals: {
          positionAbsolute: { x: node.position.x, y: node.position.y },
          handleBounds: { source: [], target: [] },
        },
      }),
    } as unknown as ReactFlowInstance;
  }

  /** Baseline Y of the device-name TEXT, in px below the device's top edge. */
  function labelBaselineOffsetPx(label: string, auxiliaryData: AuxRow[] = []): number {
    const node = deviceNode(label, auxiliaryData);
    const dxf = buildMinimalDxf((w) => {
      emitDevice(w, node, stubInstance(node), [], undefined, "USD", {});
    });
    const parsed = parse(dxf);
    const labels = parsed.entities.filter(
      (e: { type: string; layer: string }) =>
        e.type === "TEXT" && e.layer === CANONICAL_LAYERS.LABELS,
    );
    expect(labels.length).toBeGreaterThan(0);
    // DXF is Y-up inches with the canvas origin at y=0; convert back to screen px.
    return -labels[0].startPoint.y * DPI - DEVICE_Y;
  }

  // "Ethernet Switch (4-port)" and the adapters overflow the 144-px box, so the
  // canvas reserves a two-line label zone for them. DXF still emits ONE line, and
  // used to baseline it at the bottom of that zone — which read as a blank line
  // above the name (#249 follow-up). The single line must sit at the same height
  // as an unwrapped one in the same band.
  it("centers the single DXF line in a two-line label zone", () => {
    const short = labelBaselineOffsetPx("Camera");
    expect(short).toBeCloseTo(20, 3);
    expect(labelBaselineOffsetPx("Ethernet Switch (4-port)")).toBeCloseTo(short, 3);
    expect(labelBaselineOffsetPx("USB-A (M) → RJ45 (F) Adapter")).toBeCloseTo(short, 3);
  });

  it("keeps the label above the header aux rows when the zone is two lines", () => {
    const rows: AuxRow[] = [{ text: "{{deviceType}}", position: "header" }];
    // Band is 48px (32 zone + 12 row, rounded up to the 16-px grid), pad 4 → top pad 2.
    // Single line centred in the 32-px zone puts its baseline at 2 + 8 + 12 = 22,
    // comfortably clear of the aux row, which starts at 2 + 32 = 34.
    expect(labelBaselineOffsetPx("USB-A (M) → RJ45 (F) Adapter", rows)).toBeCloseTo(22, 3);
    expect(labelBaselineOffsetPx("Camera", rows)).toBeCloseTo(14, 3);
  });
});

// Room names follow the display-case preference (#294) in the DXF too — and nothing else.
// The exporter used to hardcode `data.label.toUpperCase()` as a drafting convention, the
// counterpart of RoomNode's decorative CSS `uppercase`. Both are gone: rooms are cased by
// the preference alone, exactly like device and port labels, so an as-typed export now
// reproduces what the user actually typed.
describe("emitRoom — label casing", () => {
  afterEach(() => {
    useSchematicStore.setState({ labelCase: DEFAULT_LABEL_CASE });
  });

  function roomNode(label: string): SchematicNode {
    return {
      id: "r1",
      type: "room",
      position: { x: 0, y: 0 },
      measured: { width: 400, height: 300 },
      data: { label },
    } as unknown as SchematicNode;
  }

  /** The room name as it lands in the DXF TEXT entity, for the given case mode. */
  function emittedRoomLabel(label: string, mode: LabelCaseMode): string {
    useSchematicStore.setState({ labelCase: mode });
    const node = roomNode(label);
    const dxf = buildMinimalDxf((w) => {
      emitRoom(w, node, {
        getInternalNode: () => ({
          internals: {
            positionAbsolute: { x: node.position.x, y: node.position.y },
            handleBounds: { source: [], target: [] },
          },
        }),
      } as unknown as ReactFlowInstance);
    });
    const parsed = parse(dxf);
    const labels = parsed.entities.filter(
      (e: { type: string; layer: string }) =>
        e.type === "TEXT" && e.layer === CANONICAL_LAYERS.LABELS,
    );
    expect(labels.length).toBe(1);
    return labels[0].text;
  }

  it("applies the case preference to the room name in all four modes", () => {
    expect(emittedRoomLabel("main Hall", "uppercase")).toBe("MAIN HALL");
    expect(emittedRoomLabel("main Hall", "lowercase")).toBe("main hall");
    expect(emittedRoomLabel("main Hall", "capitalize")).toBe("Main Hall");
  });

  it("emits the room name verbatim under as-typed — no drafting all-caps", () => {
    // This is the assertion that fails if anyone reinstates the hardcoded `.toUpperCase()`:
    // a mixed-case room name has to survive the export untouched in the default mode.
    for (const label of ["main Hall", "Booth", "FOH", "rack room 2"]) {
      expect(emittedRoomLabel(label, "as-typed")).toBe(label);
    }
    // Spelled out for the one case where verbatim and all-caps would otherwise agree.
    expect(emittedRoomLabel("main Hall", "as-typed")).not.toBe("MAIN HALL");
  });

  it("is display-only — the stored room label is never mutated", () => {
    const node = roomNode("main Hall");
    emittedRoomLabel("main Hall", "lowercase");
    expect((node.data as { label: string }).label).toBe("main Hall");
  });
});

// The second half of #294: I/O section headers follow the case preference in the DXF too.
// The canvas already does this via DeviceNode's `displayLabel(item.name)`; without the
// same call here a sectioned device's DXF disagrees with what's on screen.
describe("emitDevice — I/O section header casing", () => {
  afterEach(() => {
    useSchematicStore.setState({ labelCase: DEFAULT_LABEL_CASE });
  });

  /** Two sections per direction — the first section in a direction emits no separator
   *  (there's nothing above it to separate from), so the second one carries the label. */
  const PORTS = [
    { id: "p1", label: "Mic 1", direction: "input", signalType: "analog-audio", section: "mic In" },
    { id: "p2", label: "Line 1", direction: "input", signalType: "analog-audio", section: "line In" },
    { id: "p3", label: "Main", direction: "output", signalType: "analog-audio", section: "main Out" },
    { id: "p4", label: "Aux", direction: "output", signalType: "analog-audio", section: "aux Out" },
    { id: "p5", label: "Net A", direction: "bidirectional", signalType: "ethernet", section: "net A" },
    { id: "p6", label: "Net B", direction: "bidirectional", signalType: "ethernet", section: "net B" },
  ];

  const sectionedDevice = (): SchematicNode =>
    ({
      id: "n1",
      type: "device",
      position: { x: 0, y: 0 },
      measured: { width: 144, height: 200 },
      data: { label: "patch Bay", ports: PORTS, auxiliaryData: [] },
    }) as unknown as SchematicNode;

  /** Handle bounds for every port, one row apart. Bidirectional ports expose -in/-out. */
  function handleBounds() {
    const source: { id: string; x: number; y: number; width: number; height: number }[] = [];
    let row = 0;
    for (const p of PORTS) {
      const y = 40 + row * 16;
      if (p.direction === "bidirectional") {
        source.push({ id: `${p.id}-in`, x: 0, y, width: 8, height: 8 });
        source.push({ id: `${p.id}-out`, x: 136, y, width: 8, height: 8 });
      } else {
        source.push({ id: p.id, x: p.direction === "input" ? 0 : 136, y, width: 8, height: 8 });
      }
      row++;
    }
    return { source, target: [] };
  }

  /** Every LABELS-layer TEXT emitted for the sectioned device, in emission order.
   *  Index 0 is the device name; the rest are the section headers. */
  function emittedLabelTexts(mode: LabelCaseMode): string[] {
    useSchematicStore.setState({ labelCase: mode });
    const node = sectionedDevice();
    const dxf = buildMinimalDxf((w) => {
      emitDevice(
        w,
        node,
        {
          getInternalNode: () => ({
            internals: {
              positionAbsolute: { x: node.position.x, y: node.position.y },
              handleBounds: handleBounds(),
            },
          }),
        } as unknown as ReactFlowInstance,
        [],
        undefined,
        "USD",
        {},
      );
    });
    return parse(dxf)
      .entities.filter(
        (e: { type: string; layer: string }) =>
          e.type === "TEXT" && e.layer === CANONICAL_LAYERS.LABELS,
      )
      .map((e: { text: string }) => e.text);
  }

  /** Just the section headers — drops the device name at index 0. */
  const sectionHeaders = (mode: LabelCaseMode) => emittedLabelTexts(mode).slice(1);

  it("emits one header per section change, covering all three port directions", () => {
    // input / output / bidirectional each take a different branch of the separator code.
    expect(sectionHeaders("as-typed")).toEqual(["line In", "aux Out", "net B"]);
  });

  it("applies the case preference to section headers in all four modes", () => {
    expect(sectionHeaders("as-typed")).toEqual(["line In", "aux Out", "net B"]);
    expect(sectionHeaders("uppercase")).toEqual(["LINE IN", "AUX OUT", "NET B"]);
    expect(sectionHeaders("lowercase")).toEqual(["line in", "aux out", "net b"]);
    expect(sectionHeaders("capitalize")).toEqual(["Line In", "Aux Out", "Net B"]);
  });

  it("leaves section headers untouched under as-typed", () => {
    // Unlike room labels there was never a decorative uppercase here — the section text
    // was emitted raw — so as-typed must be the identity, byte for byte.
    for (const text of sectionHeaders("as-typed")) {
      expect(text).toBe(PORTS.find((p) => p.section?.toLowerCase() === text.toLowerCase())?.section);
    }
  });

  it("is display-only — the stored section names are never mutated", () => {
    sectionHeaders("uppercase");
    expect(PORTS.map((p) => p.section)).toEqual([
      "mic In", "line In", "main Out", "aux Out", "net A", "net B",
    ]);
  });
});

// ─── Whole-document emission (entity order + stub labels) ────────────────────
//
// AutoCAD, TrueView and LibreCAD all paint model-space entities in database order and
// give layers no precedence of their own, so where a label lands in the ENTITIES stream
// decides whether it is readable — and DXF text has no fill area, so a label that sits
// ON its own routed line needs a mask entity too. These pin all three consequences:
// cable IDs must follow ALL connection geometry AND carry an opaque chip (#298), and
// stub-label boxes must be in the document at all (#319 — they were skipped entirely,
// leaving the leg's cable ID as the only text at a stub end).

describe("buildDxf — connection label draw order and masking (#298)", () => {
  const devices: SchematicNode[] = [
    {
      id: "dev-switch",
      type: "device",
      position: { x: 0, y: 0 },
      measured: { width: 144, height: 80 },
      data: { label: "Rack Switch", ports: [{ id: "port-1", label: "Port 1", direction: "output", signalType: "ethernet" }] },
    },
    {
      id: "dev-display",
      type: "device",
      position: { x: 600, y: 0 },
      measured: { width: 144, height: 80 },
      data: { label: "Lobby Display", ports: [{ id: "port-1", label: "LAN 1", direction: "input", signalType: "ethernet" }] },
    },
    {
      id: "dev-camera",
      type: "device",
      position: { x: 0, y: 300 },
      measured: { width: 144, height: 80 },
      data: { label: "PTZ Camera", ports: [{ id: "port-1", label: "LAN 1", direction: "output", signalType: "ethernet" }] },
    },
    {
      id: "dev-encoder",
      type: "device",
      position: { x: 600, y: 300 },
      measured: { width: 144, height: 80 },
      data: { label: "NDI Encoder", ports: [{ id: "port-1", label: "LAN 1", direction: "input", signalType: "ethernet" }] },
    },
  ] as unknown as SchematicNode[];

  const edges = [
    { id: "e-switch-display", source: "dev-switch", target: "dev-display", sourceHandle: "port-1", targetHandle: "port-1", data: { signalType: "ethernet", cableId: "C-001" } },
    { id: "e-camera-encoder", source: "dev-camera", target: "dev-encoder", sourceHandle: "port-1", targetHandle: "port-1", data: { signalType: "ethernet", cableId: "C-002" } },
  ] as unknown as ConnectionEdge[];

  /** Both connections run dead horizontal, so the label lands exactly on the wire —
   *  the default geometry the issue is about. */
  const WIRE_Y_A = 40;
  const routedEdges = {
    "e-switch-display": straightRoute(144, WIRE_Y_A, 600),
    "e-camera-encoder": straightRoute(144, 340, 600),
  };

  afterEach(resetExportStore);

  function exportEdges(over: Record<string, unknown> = {}) {
    useSchematicStore.setState({
      nodes: devices, edges, routedEdges,
      cableIdLabelMode: "midpoint", cableIdGap: 4, cableIdMidOffset: 0,
      colorKeyEnabled: false, printView: false,
      ...over,
    });
    const dxf = buildDxf(instanceFor(devices));
    expect(dxf).not.toBeNull();
    return dxf!;
  }

  function connectionLabelOrder(over: Record<string, unknown> = {}) {
    const entities = parse(exportEdges(over)).entities as { type: string; layer: string; text?: string }[];
    const isConnectionGeometry = (e: { type: string; layer: string }) =>
      (e.type === "LINE" || e.type === "ARC") && e.layer.startsWith("EasySchematic-Connections-");
    const isCableId = (e: { type: string; layer: string; text?: string }) =>
      e.type === "MTEXT" && e.layer === CANONICAL_LAYERS.LABELS && /^C-00[12]$/.test(e.text ?? "");
    return {
      lastGeometry: entities.map(isConnectionGeometry).lastIndexOf(true),
      firstCableId: entities.findIndex(isCableId),
      cableIds: entities.filter(isCableId).map((e) => e.text),
    };
  }

  it("emits both cable IDs", () => {
    expect(connectionLabelOrder().cableIds.sort()).toEqual(["C-001", "C-002"]);
  });

  // Half the regression: labels used to be emitted inside the per-edge loop, so C-001
  // landed in the stream BEFORE the second connection's lines and that line drew
  // through it.
  it("puts every cable ID after every connection line", () => {
    const { lastGeometry, firstCableId } = connectionLabelOrder();
    expect(lastGeometry).toBeGreaterThan(-1);
    expect(firstCableId).toBeGreaterThan(lastGeometry);
  });

  // The other half, and the one ordering cannot reach: in midpoint mode with no offset
  // the label sits dead on its own wire, so it needs an opaque chip under it. Without
  // the chip the wire reads straight through the glyphs in every viewer.
  it("masks a cable ID's own connection line with an opaque chip", () => {
    const stream = rawEntityStream(exportEdges());
    const chips = stream
      .filter((e) => e.type === "SOLID" && e.layer === CANONICAL_LAYERS.LABELS)
      .map(maskBounds);
    expect(chips.length).toBe(2);

    // The midpoint of the first connection, in DXF inches.
    const labelX = (144 + 600) / 2 / DPI;
    const wireY = -WIRE_Y_A / DPI;
    const covering = chips.filter(
      (c) => c.x1 < labelX && labelX < c.x2 && c.y1 < wireY && wireY < c.y2,
    );
    expect(covering.length).toBe(1);
    // Wide enough for "C-001" plus the canvas chip's 3px side padding, not a hairline.
    expect((covering[0].x2 - covering[0].x1) * DPI).toBeGreaterThan(5 * 9 * 0.5);
  });

  it("draws each chip after all connection geometry and under its own text", () => {
    const stream = rawEntityStream(exportEdges());
    const lastGeometry = stream
      .map((e) => (e.type === "LINE" || e.type === "ARC") && e.layer.startsWith("EasySchematic-Connections-"))
      .lastIndexOf(true);
    const firstChip = stream.findIndex(
      (e) => e.type === "SOLID" && e.layer === CANONICAL_LAYERS.LABELS,
    );
    const firstCableId = stream.findIndex(
      (e) => e.type === "MTEXT" && e.pairs.some(([c, v]) => c === "1" && v === "C-001"),
    );
    expect(lastGeometry).toBeGreaterThan(-1);
    expect(firstChip).toBeGreaterThan(lastGeometry);
    expect(firstCableId).toBeGreaterThan(firstChip);
  });

  // The chip is the mask now, so the MTEXT background fill — which used ACI 7, the
  // white/black pseudo-color that inverts with the viewer's background — is gone.
  it("no longer relies on the MTEXT background fill", () => {
    const stream = rawEntityStream(exportEdges());
    const cableIdText = stream.find(
      (e) => e.type === "MTEXT" && e.pairs.some(([c, v]) => c === "1" && v === "C-001"),
    );
    expect(cableIdText).toBeDefined();
    expect(cableIdText!.pairs.some(([c]) => c === "90")).toBe(false);
  });

  it("chips endpoint-mode cable IDs too, at both ends", () => {
    const chips = rawEntityStream(exportEdges({ cableIdLabelMode: "endpoint" }))
      .filter((e) => e.type === "SOLID" && e.layer === CANONICAL_LAYERS.LABELS);
    expect(chips.length).toBe(4); // 2 connections x 2 ends
  });

  // #333. The chip first shipped as a HATCH, which put a HATCH under every cable ID in
  // every export — until then HATCH was only reachable through opt-in fills (a room
  // colour, the colour key) so nobody had one. Illustrator and the Autodesk viewer both
  // refused the whole file: an AutoCAD-lineage reader that dislikes one HATCH group
  // discards the entire drawing, not the entity. The mask is a SOLID now — four corners,
  // no options, R12-era — and these pin the shape so the finicky entity can't creep back.
  describe("mask entity shape (#333)", () => {
    it("emits no HATCH anywhere in the document", () => {
      expect(rawEntityStream(exportEdges()).some((e) => e.type === "HATCH")).toBe(false);
    });

    // The cable-ID chip fixture above has no room colour, no device header colour, no
    // annotations and the colour key off — exactly the opt-in paths that were the
    // pre-existing HATCH landmine (a room fill, a header band, an annotation fill, the
    // legend ground). Exercise all of them together so a HATCH creeping back into any one
    // emitter can't hide behind a fixture that never reaches it.
    it("still emits no HATCH with a coloured room, a coloured device header, every annotation shape and the colour key all in play", () => {
      const rf = (node: SchematicNode): ReactFlowInstance => ({
        getInternalNode: () => ({
          internals: {
            positionAbsolute: { x: node.position.x, y: node.position.y },
            handleBounds: { source: [], target: [] },
          },
        }),
      }) as unknown as ReactFlowInstance;

      const dxf = buildMinimalDxf((w) => {
        const room = {
          id: "r1", type: "room", position: { x: 0, y: 0 },
          measured: { width: 400, height: 300 },
          data: { label: "Booth", color: "#ff0000" },
        } as unknown as SchematicNode;
        emitRoom(w, room, rf(room));

        const device = {
          id: "d1", type: "device", position: { x: 0, y: 400 },
          measured: { width: 144, height: 80 },
          data: {
            label: "Rack", headerColor: "#0000ff",
            ports: [{ id: "p1", label: "In", direction: "input", signalType: "hdmi" }],
          },
        } as unknown as SchematicNode;
        emitDevice(w, device, rf(device), [], undefined, "USD", {});

        for (const shape of ["rectangle", "ellipse", "circle", "diamond", "triangle"] as const) {
          const ann = {
            id: `a-${shape}`, type: "annotation", position: { x: 500, y: 0 },
            measured: { width: 100, height: 80 },
            data: { shape, color: "#00ff00" },
          } as unknown as SchematicNode;
          emitAnnotation(w, ann, rf(ann));
        }

        emitLegend(
          w,
          [{
            id: "e1", source: "d1", target: "d1", sourceHandle: "p1", targetHandle: "p1",
            data: { signalType: "hdmi" },
          }] as unknown as ConnectionEdge[],
          undefined, undefined, undefined,
          { x: 0, y: 0 }, { x: 10, y: 10 },
        );
      });

      const stream = rawEntityStream(dxf);
      expect(stream.some((e) => e.type === "HATCH")).toBe(false);
      // Confirms every opt-in path above actually fired a fill, not just that HATCH is
      // absent because nothing tried to fill anything.
      expect(stream.filter((e) => e.type === "SOLID").length).toBeGreaterThanOrEqual(8);
    });

    it("writes each chip as a SOLID carrying the AcDbTrace subclass and four corners", () => {
      const chip = rawEntityStream(exportEdges())
        .find((e) => e.type === "SOLID" && e.layer === CANONICAL_LAYERS.LABELS);
      expect(chip).toBeDefined();
      const codes = chip!.pairs.map(([c]) => c);
      // AcDbEntity then AcDbTrace — a missing subclass marker is an instant reject.
      expect(chip!.pairs.filter(([c]) => c === "100").map(([, v]) => v))
        .toEqual(["AcDbEntity", "AcDbTrace"]);
      // All four corners, each with its full x/y/z triple.
      for (const corner of [["10", "20", "30"], ["11", "21", "31"], ["12", "22", "32"], ["13", "23", "33"]]) {
        for (const code of corner) expect(codes.filter((c) => c === code).length).toBe(1);
      }
    });

    it("orders the corners so the quad is a rectangle, not a bow tie", () => {
      const chip = rawEntityStream(exportEdges())
        .find((e) => e.type === "SOLID" && e.layer === CANONICAL_LAYERS.LABELS)!;
      // SOLID paints 10 → 11 → 13 → 12. Writing outline order straight through swaps the
      // far edge and the fill crosses itself, leaving the text half masked.
      const [c0, c1, c2, c3] = solidCorners(chip);
      expect(c0.y).toBeCloseTo(c1.y, 9); // 10-11 is one full edge
      expect(c2.y).toBeCloseTo(c3.y, 9); // 12-13 is the opposite edge
      expect(c0.x).toBeCloseTo(c2.x, 9); // and they run the same direction
      expect(c1.x).toBeCloseTo(c3.x, 9);
      expect(c0.y).not.toBeCloseTo(c2.y, 6);
    });
  });
});

describe("DxfWriter — solid fills (#333)", () => {
  function entities(emit: (w: DxfWriter) => void) {
    return rawEntityStream(buildMinimalDxf(emit));
  }

  it("fills a convex polygon with SOLID quads covering the whole shape", () => {
    // A diamond, the shape an annotation uses.
    const pts = [{ x: 2, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 2 }];
    const solids = entities((w) => w.addSolidFillPolygon("TEST", pts));
    expect(solids.map((e) => e.type)).toEqual(["SOLID"]);
    const b = maskBounds(solids[0]);
    expect(b).toEqual({ x1: 0, y1: 0, x2: 4, y2: 4 });
  });

  it("fans an odd-cornered polygon into quad + triangle, never a HATCH", () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    const solids = entities((w) => w.addSolidFillPolygon("TEST", pts));
    expect(solids.map((e) => e.type)).toEqual(["SOLID", "SOLID"]);
    // The tail triangle repeats its last corner, which is how SOLID spells a triangle.
    const tail = solidCorners(solids[1]);
    expect(tail[2]).toEqual(tail[3]);
  });

  it("polygonises an ellipse fill rather than emitting a HATCH boundary", () => {
    const solids = entities((w) => w.addSolidFillEllipse("TEST", 5, 5, 2, 0, 0.5));
    expect(solids.length).toBeGreaterThan(4);
    expect(solids.every((e) => e.type === "SOLID")).toBe(true);
    const xs = solids.flatMap((e) => solidCorners(e).map((c) => c.x));
    const ys = solids.flatMap((e) => solidCorners(e).map((c) => c.y));
    expect(Math.min(...xs)).toBeCloseTo(3, 3);
    expect(Math.max(...xs)).toBeCloseTo(7, 3);
    expect(Math.min(...ys)).toBeCloseTo(4, 3);
    expect(Math.max(...ys)).toBeCloseTo(6, 3);
  });

  it("ignores degenerate input instead of writing a two-corner fill", () => {
    expect(entities((w) => w.addSolidFillPolygon("TEST", [{ x: 0, y: 0 }, { x: 1, y: 1 }]))).toEqual([]);
    expect(entities((w) => w.addSolidFillEllipse("TEST", 0, 0, 0, 0, 1))).toEqual([]);
  });
});

describe("buildDxf — stub labels (#319)", () => {
  // One logical connection split into two legs sharing a linkedConnectionId, each ending
  // at a stub-label node — the shape convertEdgeToStubs produces.
  const LINKED = "lnk-7f31";

  const nodes = [
    {
      id: "dev-rack-switch",
      type: "device",
      position: { x: 0, y: 0 },
      measured: { width: 144, height: 80 },
      data: { label: "Rack Switch", ports: [{ id: "port-12", label: "Port 12", direction: "output", signalType: "ethernet" }] },
    },
    {
      id: "stub-a",
      type: "stub-label",
      position: { x: 208, y: 33 },
      measured: { width: 96, height: 14 },
      data: { signalType: "ethernet", linkedConnectionId: LINKED, side: "source", placed: true },
    },
    {
      id: "stub-b",
      type: "stub-label",
      position: { x: 900, y: 33 },
      measured: { width: 96, height: 14 },
      data: { signalType: "ethernet", linkedConnectionId: LINKED, side: "target", placed: true },
    },
    {
      id: "dev-lobby-display",
      type: "device",
      position: { x: 1060, y: 0 },
      measured: { width: 144, height: 80 },
      data: { label: "Lobby Display", ports: [{ id: "port-1", label: "LAN 1", direction: "input", signalType: "ethernet" }] },
    },
  ] as unknown as SchematicNode[];

  const edges = [
    { id: "e-leg-a", source: "dev-rack-switch", target: "stub-a", sourceHandle: "port-12", targetHandle: "l", data: { signalType: "ethernet", cableId: "C-014", linkedConnectionId: LINKED } },
    { id: "e-leg-b", source: "stub-b", target: "dev-lobby-display", sourceHandle: "r", targetHandle: "port-1", data: { signalType: "ethernet", cableId: "C-014", linkedConnectionId: LINKED } },
  ] as unknown as ConnectionEdge[];

  const routedEdges = {
    "e-leg-a": straightRoute(144, 40, 208),
    "e-leg-b": straightRoute(996, 40, 1060),
  };

  afterEach(resetExportStore);

  function exportWithStubs(over: Record<string, unknown> = {}) {
    useSchematicStore.setState({
      nodes, edges, routedEdges,
      stubLabelShowPort: true, stubLabelShowRoom: false, stubLabelPageMode: "cross-page",
      cableIdLabelMode: "endpoint", cableIdGap: 4,
      colorKeyEnabled: false, printView: false,
      ...over,
    });
    const dxf = buildDxf(instanceFor(nodes));
    expect(dxf).not.toBeNull();
    return dxf!;
  }

  /** Every LABELS-layer MTEXT in emission order. Text arrives DXF-escaped, so compare
   *  against escapeForMText of the expected string rather than the raw glyphs. */
  function labelTexts(dxf: string): string[] {
    return (parse(dxf).entities as { type: string; layer: string; text?: string }[])
      .filter((e) => e.type === "MTEXT" && e.layer === CANONICAL_LAYERS.LABELS)
      .map((e) => e.text ?? "");
  }

  it("writes the stub label text the canvas shows, not just the cable ID", () => {
    const texts = labelTexts(exportWithStubs());
    // Both stubs point at the far device across the split, with its far-end port.
    expect(texts).toContain(escapeForMText("→ Lobby Display [LAN 1]"));
    expect(texts).toContain(escapeForMText("← Rack Switch [Port 12]"));
  });

  // The canvas suppresses the endpoint cable ID at a stub end: the stub box already
  // names the connection there, so printing the ID at the device port AND the stub
  // would put four IDs on one logical cable. The DXF used to emit all four, and the
  // stub pill's opaque fill then clipped the two it overlapped (#319).
  it("suppresses the cable ID at the stub end of each leg", () => {
    const texts = labelTexts(exportWithStubs());
    expect(texts.filter((t) => t === "C-014").length).toBe(2); // one per leg, device end only
  });

  it("keeps the cable ID at the stub end when the mode is midpoint", () => {
    // Midpoint labels aren't at an endpoint at all, so nothing is suppressed —
    // matching OffsetEdge, which only guards the endpoint branch.
    const texts = labelTexts(exportWithStubs({ cableIdLabelMode: "midpoint" }));
    expect(texts.filter((t) => t === "C-014").length).toBe(2);
  });

  it("honours the per-stub port toggle", () => {
    const texts = labelTexts(exportWithStubs({ stubLabelShowPort: false }));
    expect(texts).toContain(escapeForMText("→ Lobby Display"));
    expect(texts).toContain(escapeForMText("← Rack Switch"));
  });

  /** Index of the mask whose bounds are the given stub node's box, or -1. */
  function stubPillIndex(stream: ReturnType<typeof rawEntityStream>, x: number, y: number, w: number, h: number) {
    return stream.findIndex((e) => {
      if (e.type !== "SOLID" || e.layer !== CANONICAL_LAYERS.LABELS) return false;
      const b = maskBounds(e);
      return Math.abs(b.x1 - x / DPI) < 1e-6 && Math.abs(b.y1 + (y + h) / DPI) < 1e-6
        && Math.abs(b.x2 - b.x1 - w / DPI) < 1e-6 && Math.abs(b.y2 - b.y1 - h / DPI) < 1e-6;
    });
  }

  it("draws each stub pill as an opaque fill plus an outline on the labels layer", () => {
    const stream = rawEntityStream(exportWithStubs());
    // Both stub node boxes are filled...
    expect(stubPillIndex(stream, 208, 33, 96, 14)).toBeGreaterThan(-1);
    expect(stubPillIndex(stream, 900, 33, 96, 14)).toBeGreaterThan(-1);
    // ...and outlined. Two pills + one chip per surviving cable ID (2) = 4 outlines.
    const outlines = stream.filter(
      (e) => e.type === "LWPOLYLINE" && e.layer === CANONICAL_LAYERS.LABELS,
    );
    expect(outlines.length).toBe(4);
  });

  it("emits the stub boxes after all connection geometry", () => {
    const stream = rawEntityStream(exportWithStubs());
    const lastGeometry = stream
      .map((e) => (e.type === "LINE" || e.type === "ARC") && e.layer.startsWith("EasySchematic-Connections-"))
      .lastIndexOf(true);
    expect(lastGeometry).toBeGreaterThan(-1);
    expect(stubPillIndex(stream, 208, 33, 96, 14)).toBeGreaterThan(lastGeometry);
    expect(stubPillIndex(stream, 900, 33, 96, 14)).toBeGreaterThan(lastGeometry);
  });

  it("follows the display-case preference like every other label", () => {
    useSchematicStore.setState({ labelCase: "uppercase" });
    const texts = labelTexts(exportWithStubs());
    expect(texts).toContain(escapeForMText("→ LOBBY DISPLAY [LAN 1]"));
  });
});
