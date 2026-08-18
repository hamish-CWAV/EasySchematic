import { describe, it, expect, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_TEMPLATES, CARD_TEMPLATES } from "../deviceLibrary";
import { DEVICE_TYPE_TO_CATEGORY, DEVICE_TYPE_ALIASES, ALL_CATEGORIES, DEVICE_TYPE_LABELS } from "../deviceTypeCategories";
import { checkDeviceTypeMapped, checkApprovalDeviceType } from "../../api/src/validate";
import { validateTemplate } from "../import/validate";
import { approveSubmission } from "../../devices/src/api";

// Every id that still has two bundled templates on it (#300 audit, 2026-08-18).
// D1 was seeded from these ids and kept whichever entry landed last, so each of
// these is a template the Device Library cannot show. Reported on #300, not
// fixed here — this set exists so the count can only shrink.
const KNOWN_COLLIDED_IDS = [
  "c0a80101-003d-4000-8000-000000000061", // ATEM Mini / PowerCON Distro
  "c0a80101-003e-4000-8000-000000000062", // ATEM Mini Pro / PowerCON Thru Distro
  "c0a80101-00ce-4000-8000-000000000206", // USB-C (M) → USB-A (F) Adapter / Panasonic RZ12K
  "c0a80101-00cf-4000-8000-000000000207", // USB-C (M) → USB-B (F) Adapter / D'San Perfect Cue
  "c0a80101-00d0-4000-8000-000000000208", // mini-XLR (M) → XLR-3 (F) Adapter / Brainstorm SR-112
  "c0a80101-00d1-4000-8000-000000000209", // IEC (M) → Edison (F) Adapter / MIDI Merge 4x2
  "c0a80101-00d2-4000-8000-000000000210", // IEC (M) → powerCON (F) Adapter / MIDI Thru 1x4
  "c0a80101-010c-4000-8000-000000000344", // Disguise VX 1 / Dataton WATCHPAX 64
  "c0a80101-010d-4000-8000-000000000345", // Novastar NovaPro UHD Jr / Disguise VX 2
  "c0a80101-010e-4000-8000-000000000346", // Brompton Tessera S8 / Disguise VX 3
  "c0a80101-010f-4000-8000-000000000347", // Brompton Tessera R2+ / Disguise GX 1
  "c0a80101-0110-4000-8000-000000000348", // Disguise GX 2 / ETC Eos Apex
  "c0a80101-0111-4000-8000-000000000349", // Disguise GX 2C / grandMA3 full-size
  "c0a80101-0112-4000-8000-000000000350", // Disguise GX 3 / grandMA3 compact XT
  "c0a80101-0240-4000-8000-000000000721", // BMD Videohub 80x80 12G / Wall Plate 1-Port Keystone
];

function idCounts(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const t of [...DEVICE_TEMPLATES, ...CARD_TEMPLATES]) {
    if (!t.id) continue;
    if (!byId.has(t.id)) byId.set(t.id, []);
    byId.get(t.id)!.push(t.label);
  }
  return byId;
}

describe("#300 — TB (M) → RJ45 (F) Adapter id collision", () => {
  it("no longer shares an id with BMD Video Assist 12G HDR 7in", () => {
    const adapter = DEVICE_TEMPLATES.find((t) => t.label === "TB (M) → RJ45 (F) Adapter");
    const recorder = DEVICE_TEMPLATES.find((t) => t.label === "BMD Video Assist 12G HDR 7in");
    expect(adapter).toBeDefined();
    expect(recorder).toBeDefined();
    expect(recorder!.id).toBe("c0a80101-00f8-4000-8000-000000000324");
    expect(adapter!.id).not.toBe(recorder!.id);
  });

  it("gives the adapter an id no other bundled template holds", () => {
    const adapter = DEVICE_TEMPLATES.find((t) => t.label === "TB (M) → RJ45 (F) Adapter")!;
    expect(idCounts().get(adapter.id!)).toEqual(["TB (M) → RJ45 (F) Adapter"]);
  });

  it("has no duplicate template ids beyond the audited backlog", () => {
    const duplicates = [...idCounts()]
      .filter(([, labels]) => labels.length > 1)
      .map(([id]) => id)
      .sort();
    expect(duplicates).toEqual([...KNOWN_COLLIDED_IDS].sort());
  });
});

// ALL_CATEGORIES as it stood at 97f9fc7, before the #315 mappings landed. Every
// new type had to reuse one of these — a 33rd entry means a bucket was invented.
const PRE_315_CATEGORIES = [
  "Amplifiers", "Audio", "Audio Expansion", "Audio I/O", "Cable Accessories",
  "Cloud Services", "Codecs", "Control", "Displays", "Distribution",
  "Expansion Cards", "Infrastructure", "Intercom", "KVM / Extenders", "LED Video",
  "Lighting", "Media Servers", "Microphones", "Mixing Consoles", "Monitoring",
  "Networking", "Peripherals", "Powered Mixers", "Processing", "Projection",
  "Recording", "Sources", "Speakers", "Storage", "Storage Media", "Switching",
  "Wireless",
];

describe("#315(a) — device types that were only ever free-typed into D1", () => {
  // The canonical slug for each concept the issue's group 3 covers.
  const NEWLY_MAPPED = [
    "siren",
    "door-strike",
    "magnetic-sensor",
    "v-lock",
    "turret-camera",
    "pir-sensor",
    "keypad",
    "dry-contact",
    "bus-power-supply",
    "24vdc-power-supply",
    "dali-power-supply-and-line-break",
    "ups",
    "hard-drive",
    "rf-to-ethernet-integrator",
    "subwoofer",
    "hdmi-extender",
    "audio-over-cat-extender",
    "audio-matrix",
    "streaming-decoder",
    "streaming-transceiver",
    "video-transceiver",
    "avoip-encoder",
    "avoip-decoder",
    "conferencing-bridge",
    "digital-signage-player",
  ];

  it.each(NEWLY_MAPPED)("maps %s to a category", (type) => {
    expect(DEVICE_TYPE_TO_CATEGORY[type]).toBeTruthy();
  });

  it("reuses existing categories rather than inventing new buckets", () => {
    // Every category the new types land in must already be in live use; the
    // counts come from https://api.easyschematic.live/templates/summary.
    const LIVE_CATEGORIES = new Set([
      "Monitoring",
      "Control",
      "Lighting",
      "Infrastructure",
      "Storage",
      "Networking",
      "Speakers",
      "KVM / Extenders",
      "Audio",
      "Media Servers",
    ]);
    for (const type of NEWLY_MAPPED) {
      expect(LIVE_CATEGORIES.has(DEVICE_TYPE_TO_CATEGORY[type])).toBe(true);
    }
    // ALL_CATEGORIES is derived from DEVICE_TYPE_TO_CATEGORY, so asserting the
    // new types appear in it can never fail. What can regress is the catalogue
    // growing a bucket, so pin the whole set to what it was before #315.
    expect(ALL_CATEGORIES).toEqual(PRE_315_CATEGORIES);
  });

  it("collapses the near-duplicate pairs instead of cementing the split", () => {
    expect(DEVICE_TYPE_ALIASES).toEqual({
      "pir-motion-sensor": "pir-sensor",
      "passive-subwoofer": "subwoofer",
      "AVoIP Encoder": "avoip-encoder",
    });
    for (const [alias, canonical] of Object.entries(DEVICE_TYPE_ALIASES)) {
      // The alias must stay unpickable, or the picker offers both spellings.
      expect(DEVICE_TYPE_TO_CATEGORY[alias]).toBeUndefined();
      expect(DEVICE_TYPE_TO_CATEGORY[canonical]).toBeTruthy();
    }
  });

  it("renders the new acronym-bearing slugs as AV labels, not Title Case mush", () => {
    expect(DEVICE_TYPE_LABELS["ups"]).toBe("UPS");
    expect(DEVICE_TYPE_LABELS["pir-sensor"]).toBe("PIR Sensor");
    expect(DEVICE_TYPE_LABELS["avoip-encoder"]).toBe("AVoIP Encoder");
    expect(DEVICE_TYPE_LABELS["24vdc-power-supply"]).toBe("24VDC Power Supply");
    expect(DEVICE_TYPE_LABELS["rf-to-ethernet-integrator"]).toBe("RF To Ethernet Integrator");
    expect(DEVICE_TYPE_LABELS["dali-power-supply-and-line-break"]).toBe("DALI Power Supply And Line Break");
    expect(DEVICE_TYPE_LABELS["hdmi-extender"]).toBe("HDMI Extender");
  });
});

describe("#315(b) — approval refuses unmapped device types", () => {
  it("accepts a mapped type", () => {
    expect(checkDeviceTypeMapped("streaming-decoder")).toBeNull();
    expect(checkDeviceTypeMapped("network-switch")).toBeNull();
  });

  it("rejects a free-typed slug and names the file to edit", () => {
    // "Camera Tracker" is one of the real orphans this gate exists to stop.
    const err = checkDeviceTypeMapped("Camera Tracker");
    expect(err).toContain("Camera Tracker");
    expect(err).toContain("src/deviceTypeCategories.ts");
  });

  it("rejects the folded aliases and names the spelling that won", () => {
    expect(checkDeviceTypeMapped("pir-motion-sensor")).toContain('"pir-sensor"');
    expect(checkDeviceTypeMapped("passive-subwoofer")).toContain('"subwoofer"');
    expect(checkDeviceTypeMapped("AVoIP Encoder")).toContain('"avoip-encoder"');
  });

  it("rejects missing and non-string values", () => {
    expect(checkDeviceTypeMapped(undefined)).not.toBeNull();
    expect(checkDeviceTypeMapped(null)).not.toBeNull();
    expect(checkDeviceTypeMapped(42)).not.toBeNull();
    expect(checkDeviceTypeMapped("")).not.toBeNull();
  });

  it("does not let Object.prototype keys pass as mapped types", () => {
    expect(checkDeviceTypeMapped("toString")).not.toBeNull();
    expect(checkDeviceTypeMapped("constructor")).not.toBeNull();
  });
});

describe("#315(b) — the gate blocks new orphans without blocking repairs", () => {
  // "Power Amplifier" is one of the 101 unmapped types already live in D1,
  // spread across 9 templates. Corrections to those must stay approvable.
  it("lets an update through when it leaves the unmapped type alone", () => {
    expect(checkApprovalDeviceType("update", "Power Amplifier", "Power Amplifier")).toBeNull();
  });

  it("still blocks an update that changes the type to an unmapped one", () => {
    expect(checkApprovalDeviceType("update", "Camera Tracker", "network-switch")).not.toBeNull();
  });

  it("blocks a create with an unmapped type even when nothing changed", () => {
    expect(checkApprovalDeviceType("create", "Power Amplifier", null)).not.toBeNull();
  });

  it("lets an update onto a mapped type through", () => {
    expect(checkApprovalDeviceType("update", "amplifier", "Power Amplifier")).toBeNull();
  });

  it("lets a create with a mapped type through", () => {
    expect(checkApprovalDeviceType("create", "streaming-decoder", null)).toBeNull();
  });
});

describe("#315(b) — the refusal actually reaches the moderator", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respondWith(body: string, status: number, contentType = "application/json") {
    globalThis.fetch = (async () =>
      new Response(body, { status, headers: { "Content-Type": contentType } })) as typeof fetch;
  }

  it("surfaces the guard's message instead of a bare status code", async () => {
    respondWith(JSON.stringify({ error: checkDeviceTypeMapped("Camera Tracker") }), 400);
    await expect(approveSubmission("sub-1")).rejects.toThrow("src/deviceTypeCategories.ts");
  });

  it("falls back to the status when the body carries no error text", async () => {
    respondWith("<html>gateway timeout</html>", 504, "text/html");
    await expect(approveSubmission("sub-1")).rejects.toThrow("Failed to approve: 504");
  });

  it("resolves on success", async () => {
    respondWith(JSON.stringify({ ok: true }), 200);
    await expect(approveSubmission("sub-1")).resolves.toBeUndefined();
  });
});

describe("stray compiled .js beside the TypeScript sources", () => {
  // Vite and esbuild resolve .js before .ts, so a stale `tsc` emit next to a
  // source file silently overrides it — a checkout carrying src/deviceTypeCategories.js
  // loads the pre-#315 map in `npm run dev`, the devices site and `wrangler dev`
  // while CI stays green, because .gitignore hides the file. Fail loudly instead.
  it("does not exist in any of the three source trees .gitignore guards", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const strays: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) strays.push(relative(root, full));
      }
    };
    for (const tree of ["src", "devices/src", "docs/src"]) walk(join(root, tree));
    expect(strays, "Stale tsc emit shadowing a .ts source — delete these files").toEqual([]);
  });
});

describe("#315 — CSV/JSON import points at the canonical spelling too", () => {
  function templateWith(deviceType: string) {
    return {
      label: "Triad SlimSub Bronze-4",
      deviceType,
      manufacturer: "Triad",
      modelNumber: "SLIMSUB-BRONZE-4",
      ports: [],
    };
  }

  it("names the winning slug for a known alias", () => {
    const errors = validateTemplate(templateWith("passive-subwoofer")).errors.join(" ");
    expect(errors).toContain('use "subwoofer"');
  });

  it("leaves the plain unknown-type error alone", () => {
    const errors = validateTemplate(templateWith("Camera Tracker")).errors.join(" ");
    expect(errors).toContain('Unknown deviceType "Camera Tracker"');
    expect(errors).not.toContain("use \"");
  });
});
