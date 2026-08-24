/**
 * The default device header color (#354).
 *
 * Two settings feed one value: an app-level preference in localStorage (every project on
 * this machine) and a per-project override that travels inside the schematic file. The
 * project override wins where set, the app preference is next, and with neither set a new
 * device carries no `headerColor` at all so DeviceNode keeps painting `--color-surface`.
 *
 * The color is stamped at placement, never resolved at paint time, so the tests below also
 * pin the thing users would notice most if it broke: changing either setting must leave
 * devices already on the canvas exactly as they are.
 *
 * Driven through the store's real `addDevice` / `insertAdapter` over the seeded test
 * fixture (#307), whose port ids end in -in/-out the way the app's really do.
 *
 * The store reads editor preferences from localStorage at import time, so a minimal
 * in-memory localStorage is installed before the store is imported.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fixture from "../testSchematic/schematic.json";
import { buildImportResult, matchDevices, type ParsedConnection } from "../csvImport";
import { planDeviceSwap } from "../deviceSwap";
import {
  DEFAULT_DEVICE_HEADER_COLOR_KEY,
  normalizeHeaderColor,
  resolveDefaultDeviceHeaderColor,
} from "../deviceHeaderColor";
import type { DeviceData, DeviceNode, DeviceTemplate, SchematicFile } from "../types";

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

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  if (!globalThis.crypto?.randomUUID) {
    (globalThis as { crypto?: unknown }).crypto = {
      randomUUID: () => "test-" + Math.random().toString(36).slice(2),
    };
  }
  ({ useSchematicStore } = await import("../store"));
});

const file = fixture as unknown as SchematicFile;

/** A minimal library template — one input, one output, in the -in/-out id shape the
 *  seeded fixture and the real device library both use. */
const TEMPLATE: DeviceTemplate = {
  id: "test-scaler",
  deviceType: "converter",
  label: "Test Scaler",
  color: "#1d4ed8",
  ports: [
    { id: "scaler-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
    { id: "scaler-hdmi-out", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
  ],
};

/** A different model to swap the placed device for — same port shape, its own body color. */
const SWAP_TARGET: DeviceTemplate = {
  id: "test-scaler-mk2",
  deviceType: "converter",
  label: "Test Scaler mk2",
  color: "#15803d",
  ports: [
    { id: "mk2-hdmi-in", label: "HDMI In", signalType: "hdmi", direction: "input", connectorType: "hdmi" },
    { id: "mk2-hdmi-out", label: "HDMI Out", signalType: "hdmi", direction: "output", connectorType: "hdmi" },
  ],
};

/** The adapter offered for the fixture's TS-out → XLR-in mismatch. */
const TS_TO_XLR: DeviceTemplate = {
  id: "test-ts-xlr",
  deviceType: "cable-accessory",
  label: "TS → XLR Adapter",
  ports: [
    { id: "adapter-ts-in", label: "TS In", signalType: "analog-audio", direction: "input", connectorType: "ts-quarter" },
    { id: "adapter-xlr-out", label: "XLR Out", signalType: "analog-audio", direction: "output", connectorType: "xlr-3" },
  ],
};

beforeEach(() => {
  localStorage.removeItem(DEFAULT_DEVICE_HEADER_COLOR_KEY);
  // Loaded through the store's real open-a-file path rather than by assigning nodes
  // straight into state, so the node id counter is synced past the fixture's own
  // device-1…device-N and a freshly placed device gets an id nothing else is using.
  useSchematicStore.getState().importFromJSON(structuredClone(file));
  useSchematicStore.setState({
    appDefaultDeviceHeaderColor: undefined,
    defaultDeviceHeaderColor: undefined,
    templatePresets: {},
    pendingIncompatibleConnection: null,
  });
});

/** The device `addDevice` just appended. */
function lastDevice(): DeviceData {
  const nodes = useSchematicStore.getState().nodes;
  return (nodes[nodes.length - 1] as DeviceNode).data;
}

function place(): DeviceData {
  useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
  return lastDevice();
}

describe("default device header color — precedence (#354)", () => {
  it("leaves a new device without a header color when neither setting is set", () => {
    expect(place().headerColor).toBeUndefined();
  });

  it("stamps the app preference when only it is set", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    expect(place().headerColor).toBe("#8b1a1a");
  });

  it("stamps the project override when only it is set", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(place().headerColor).toBe("#0f766e");
  });

  it("lets the project override win over the app preference", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(place().headerColor).toBe("#0f766e");
  });

  it("falls back to the app preference when the project override is cleared", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().setDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBe("#8b1a1a");
  });

  it("leaves the device colorless again once both are cleared", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(undefined);
    expect(place().headerColor).toBeUndefined();
  });

  it("keeps the device's own body color independent of the header color", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    const data = place();
    expect(data.color).toBe("#1d4ed8");
    expect(data.headerColor).toBe("#0f766e");
  });

  it("resolves the same way outside the store", () => {
    expect(resolveDefaultDeviceHeaderColor("#0f766e", "#8b1a1a")).toBe("#0f766e");
    expect(resolveDefaultDeviceHeaderColor(undefined, "#8b1a1a")).toBe("#8b1a1a");
    expect(resolveDefaultDeviceHeaderColor(undefined, undefined)).toBeUndefined();
  });
});

describe("default device header color — creation paths (#354)", () => {
  it("stamps a device created for editing (the custom-device path)", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().createAndEditDevice(TEMPLATE, { x: 0, y: 0 });
    expect(lastDevice().headerColor).toBe("#0f766e");
  });

  it("stamps an off-canvas patch panel", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    const id = useSchematicStore.getState().addOffCanvasPanel(TEMPLATE);
    const node = useSchematicStore.getState().nodes.find((n) => n.id === id) as DeviceNode;
    expect(node.data.headerColor).toBe("#0f766e");
  });

  it("stamps an auto-inserted adapter", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    // Combo Jack Box ▸ TS Out → Amp ▸ XLR In 2: one analog-audio signal, mismatched
    // connectors, which is the shape that offers an adapter instead of wiring straight
    // through. onConnect parks it as a pending incompatible connection first.
    const before = new Set(useSchematicStore.getState().nodes.map((n) => n.id));
    useSchematicStore.getState().onConnect({
      source: "device-16",
      sourceHandle: "combo-ts-out",
      target: "device-6",
      targetHandle: "amp-xlr-in-2",
    });
    expect(useSchematicStore.getState().pendingIncompatibleConnection).toBeTruthy();

    expect(useSchematicStore.getState().insertAdapterBetween(TS_TO_XLR)).not.toBe(false);

    const adapter = useSchematicStore
      .getState()
      .nodes.find((n) => !before.has(n.id) && n.type === "device") as DeviceNode | undefined;
    expect(adapter).toBeTruthy();
    expect(adapter!.data.headerColor).toBe("#0f766e");
  });

  it("stamps every device a CSV import creates", () => {
    const connections: ParsedConnection[] = [
      {
        sourceDevice: "Wireless Mic RX",
        sourcePort: "XLR Out",
        destDevice: "Mixer",
        destPort: "In 1",
        signalType: "analog-audio",
        sourceRoom: "Sanctuary",
        destRoom: "Sanctuary",
      },
    ];
    const { nodes } = buildImportResult(connections, matchDevices(connections, []), {
      defaultHeaderColor: "#0f766e",
    });

    const devices = nodes.filter((n) => n.type === "device") as DeviceNode[];
    expect(devices.length).toBe(2);
    for (const d of devices) expect(d.data.headerColor).toBe("#0f766e");
  });

  it("leaves imported devices colorless when no default is resolved", () => {
    const connections: ParsedConnection[] = [
      {
        sourceDevice: "Wireless Mic RX",
        sourcePort: "XLR Out",
        destDevice: "Mixer",
        destPort: "In 1",
        signalType: "analog-audio",
        sourceRoom: "",
        destRoom: "",
      },
    ];
    const { nodes } = buildImportResult(connections, matchDevices(connections, []));

    const devices = nodes.filter((n) => n.type === "device") as DeviceNode[];
    expect(devices.length).toBe(2);
    for (const d of devices) expect(d.data.headerColor).toBeUndefined();
  });
});

describe("default device header color — survives a device swap (#354)", () => {
  it("keeps the stamped color when the device is swapped for another model", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const nodeId = useSchematicStore.getState().nodes.at(-1)!.id;
    expect(lastDevice().headerColor).toBe("#8b1a1a");

    const state = useSchematicStore.getState();
    const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
    useSchematicStore
      .getState()
      .swapDevice(nodeId, planDeviceSwap(node.data, nodeId, SWAP_TARGET, state.edges));

    const swapped = useSchematicStore.getState().nodes.find((n) => n.id === nodeId) as DeviceNode;
    // The model and its body color come from the new template; the header color is the
    // device's own and stays put.
    expect(swapped.data.model).toBe("Test Scaler mk2");
    expect(swapped.data.color).toBe("#15803d");
    expect(swapped.data.headerColor).toBe("#8b1a1a");
  });

  it("does not invent a header color for a device that never had one", () => {
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const nodeId = useSchematicStore.getState().nodes.at(-1)!.id;
    expect(lastDevice().headerColor).toBeUndefined();

    // The setting changes after placement — a swap must not retroactively stamp it.
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");

    const state = useSchematicStore.getState();
    const node = state.nodes.find((n) => n.id === nodeId) as DeviceNode;
    useSchematicStore
      .getState()
      .swapDevice(nodeId, planDeviceSwap(node.data, nodeId, SWAP_TARGET, state.edges));

    const swapped = useSchematicStore.getState().nodes.find((n) => n.id === nodeId) as DeviceNode;
    expect(swapped.data.headerColor).toBeUndefined();
  });
});

describe("default device header color — no retroactive recolor (#354)", () => {
  it("leaves devices already on the canvas alone when either setting changes", () => {
    const before = JSON.stringify(useSchematicStore.getState().nodes);

    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    expect(JSON.stringify(useSchematicStore.getState().nodes)).toBe(before);
  });

  it("leaves an already-placed device alone when the setting changes afterwards", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 0, y: 0 });
    const placedId = useSchematicStore.getState().nodes.at(-1)!.id;

    useSchematicStore.getState().setDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().addDevice(TEMPLATE, { x: 200, y: 0 });

    const placed = useSchematicStore.getState().nodes.find((n) => n.id === placedId) as DeviceNode;
    expect(placed.data.headerColor).toBe("#0f766e");
    expect(lastDevice().headerColor).toBe("#8b1a1a");
  });
});

describe("default device header color — persistence (#354)", () => {
  it("writes the project override into the exported schematic file", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    expect(useSchematicStore.getState().exportToJSON().defaultDeviceHeaderColor).toBe("#0f766e");
  });

  it("omits the project override from the file when it isn't set", () => {
    expect(useSchematicStore.getState().exportToJSON().defaultDeviceHeaderColor).toBeUndefined();
  });

  it("round-trips the project override through export and import", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");
    const exported = JSON.parse(JSON.stringify(useSchematicStore.getState().exportToJSON())) as SchematicFile;

    useSchematicStore.getState().setDefaultDeviceHeaderColor(undefined);
    useSchematicStore.getState().importFromJSON(exported);

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBe("#0f766e");
    expect(place().headerColor).toBe("#0f766e");
  });

  it("defaults to unset when an older file has no such field", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    // A file written before #354 — the key simply isn't there.
    const legacy = JSON.parse(JSON.stringify(file)) as SchematicFile;
    delete legacy.defaultDeviceHeaderColor;
    useSchematicStore.getState().importFromJSON(legacy);

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBeUndefined();
    expect(place().headerColor).toBeUndefined();
  });

  it("ignores a junk color in a loaded file rather than stamping it onto devices", () => {
    const tampered = JSON.parse(JSON.stringify(file)) as SchematicFile;
    (tampered as unknown as Record<string, unknown>).defaultDeviceHeaderColor = "javascript:alert(1)";
    useSchematicStore.getState().importFromJSON(tampered);

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBeUndefined();
    expect(place().headerColor).toBeUndefined();
  });

  it("keeps the app preference out of the schematic file", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    expect(useSchematicStore.getState().exportToJSON().defaultDeviceHeaderColor).toBeUndefined();
  });

  it("persists the app preference to localStorage and clears it on reset", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    expect(localStorage.getItem(DEFAULT_DEVICE_HEADER_COLOR_KEY)).toBe("#8b1a1a");

    useSchematicStore.getState().setAppDefaultDeviceHeaderColor(undefined);
    expect(localStorage.getItem(DEFAULT_DEVICE_HEADER_COLOR_KEY)).toBeNull();
  });

  it("drops the project override on New Schematic but keeps the app preference", () => {
    useSchematicStore.getState().setAppDefaultDeviceHeaderColor("#8b1a1a");
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#0f766e");

    useSchematicStore.getState().newSchematic();

    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBeUndefined();
    expect(useSchematicStore.getState().appDefaultDeviceHeaderColor).toBe("#8b1a1a");
    expect(place().headerColor).toBe("#8b1a1a");
  });
});

describe("default device header color — app preference reload (#354)", () => {
  // Reloading the store re-reads the ~1.3MB device library, so allow a generous ceiling.
  const RELOAD_TIMEOUT = 30000;

  it("reads the stored app preference back on the next session", async () => {
    const storage = new MemStorage();
    storage.setItem(DEFAULT_DEVICE_HEADER_COLOR_KEY, "#8b1a1a");
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    vi.resetModules();

    const reloaded = (await import("../store")).useSchematicStore;
    expect(reloaded.getState().appDefaultDeviceHeaderColor).toBe("#8b1a1a");
  }, RELOAD_TIMEOUT);

  it("ignores a junk stored value instead of stamping it onto devices", async () => {
    const storage = new MemStorage();
    storage.setItem(DEFAULT_DEVICE_HEADER_COLOR_KEY, "chartreuse");
    (globalThis as { localStorage?: unknown }).localStorage = storage;
    vi.resetModules();

    const reloaded = (await import("../store")).useSchematicStore;
    expect(reloaded.getState().appDefaultDeviceHeaderColor).toBeUndefined();
  }, RELOAD_TIMEOUT);
});

describe("header color normalization (#354)", () => {
  it("accepts hex colors and lowercases them", () => {
    expect(normalizeHeaderColor("#0F766E")).toBe("#0f766e");
  });

  it("expands the 3-digit shorthand, which a color picker cannot show", () => {
    expect(normalizeHeaderColor("  #abc  ")).toBe("#aabbcc");
    expect(normalizeHeaderColor("#F00")).toBe("#ff0000");
  });

  it("stamps the expanded form onto devices, so the picker and the header agree", () => {
    useSchematicStore.getState().setDefaultDeviceHeaderColor("#abc");
    expect(useSchematicStore.getState().defaultDeviceHeaderColor).toBe("#aabbcc");
    expect(place().headerColor).toBe("#aabbcc");
  });

  it("rejects anything that isn't a hex color", () => {
    for (const junk of ["teal", "rgb(1,2,3)", "var(--color-surface)", "#12345", "", 42, null, undefined]) {
      expect(normalizeHeaderColor(junk)).toBeUndefined();
    }
  });
});
