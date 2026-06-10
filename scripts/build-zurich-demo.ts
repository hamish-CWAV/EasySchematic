// Builds /demo-zurich.json — a hand-mapped recreation of the Zurich Fitout AV
// drawing (6 meeting/colab rooms + arrival) for testing JSON import.
//
// Library substitutions made because no exact bundled template exists:
//   - LG 55UR640S0TD               -> generic "TV"            (extended ports inline)
//   - BrightSign XD235             -> BrightSign XD1035       (real template, same family)
//   - Crestron DM-NVX-D30          -> hand-authored ports     (DM-NVX-351 exists but ports differ)
//   - Crestron HD-CONV-USB-300     -> hand-authored ports     (no Crestron HD-CONV template)
//   - Dell Optiplex 7080 Micro     -> hand-authored ports     (acts as UC Engine PC)
//   - Crestron TS-1070-B-S         -> hand-authored ports     (no touch panel template)
//   - Crestron TSS-770-B-S         -> hand-authored ports     (no room-booking template)
//   - Crestron T3R-770-LB-B-S      -> hand-authored ports     (no light-bar template)
//   - Crestron CEN-ODT-C-POE       -> hand-authored ports     (no occupancy-sensor template)
//   - Jabra PanaCast 50            -> hand-authored ports     (no Jabra Video Bar template)
//   - Wall Plate (HDMI passthru)   -> hand-authored ports
//   - Client Laptop                -> generic "Computer" template (real)

import { writeFileSync } from "fs";

const ROOM_W = 1500;
const ROOM_H = 1100;
const ROOM_GAP_X = 100;
const ROOM_GAP_Y = 120;

// helpers ------------------------------------------------------------
let nodeCounter = 0;
let edgeCounter = 0;
const newNodeId = () => `node-${++nodeCounter}`;
const newEdgeId = () => `edge-${++edgeCounter}`;
const portId = (deviceKey, slot) => `p-${deviceKey}-${slot}`;

interface Port {
  id: string;
  label: string;
  signalType: string;
  direction: "input" | "output" | "bidirectional";
  connectorType: string;
}

const nodes: any[] = [];
const edges: any[] = [];
const handles: Record<string, Record<string, string>> = {}; // device -> port label -> port id

function addRoom(label: string, x: number, y: number, w: number, h: number, parentId?: string) {
  const id = newNodeId();
  const node: any = {
    id, type: "room",
    position: { x, y },
    style: { width: w, height: h },
    data: { label, locked: false },
    zIndex: -1,
  };
  if (parentId) node.parentId = parentId;
  nodes.push(node);
  return id;
}

function addDevice(opts: {
  key: string;
  label: string;
  deviceType: string;
  x: number; y: number;
  parentId?: string;
  templateId?: string;
  manufacturer?: string;
  modelNumber?: string;
  ports: { label: string; signal: string; dir: "input" | "output" | "bidirectional"; connector: string }[];
}) {
  const id = newNodeId();
  const ports: Port[] = opts.ports.map((p, i) => ({
    id: portId(opts.key, i),
    label: p.label,
    signalType: p.signal,
    direction: p.dir,
    connectorType: p.connector,
  }));
  // index by label for easy lookup
  handles[opts.key] = {};
  for (const p of ports) handles[opts.key][p.label] = p.id;

  const data: any = {
    label: opts.label,
    deviceType: opts.deviceType,
    ports,
  };
  if (opts.templateId) data.templateId = opts.templateId;
  if (opts.manufacturer) data.manufacturer = opts.manufacturer;
  if (opts.modelNumber) data.modelNumber = opts.modelNumber;

  const node: any = { id, type: "device", position: { x: opts.x, y: opts.y }, data };
  if (opts.parentId) node.parentId = opts.parentId;
  nodes.push(node);
  return { id, key: opts.key };
}

function connect(srcKey: string, srcPort: string, dstKey: string, dstPort: string, signal: string, label?: string) {
  const srcNode = nodes.find((n) => n.type === "device" && handles[srcKey] && Object.values(handles[srcKey]).includes(handles[srcKey][srcPort]));
  // simpler: find by key
  const find = (k: string) => nodes.find((n) => n.type === "device" && n.data.ports?.some((p: any) => p.id === handles[k][srcPort]) || handles[k]);
  const srcDeviceId = nodes.find((n) => n.type === "device" && n.data.ports?.some((p: any) => p.id === handles[srcKey][srcPort]))?.id;
  const dstDeviceId = nodes.find((n) => n.type === "device" && n.data.ports?.some((p: any) => p.id === handles[dstKey][dstPort]))?.id;
  if (!srcDeviceId || !dstDeviceId) throw new Error(`bad connect ${srcKey}.${srcPort} -> ${dstKey}.${dstPort}`);
  const edge: any = {
    id: newEdgeId(),
    source: srcDeviceId,
    target: dstDeviceId,
    sourceHandle: handles[srcKey][srcPort],
    targetHandle: handles[dstKey][dstPort],
    data: { signalType: signal },
    style: { stroke: `var(--color-${signal})`, strokeWidth: 2 },
  };
  if (label) edge.data.cableId = label;
  edges.push(edge);
}

// Subroom layout inside a meeting room ----------------------------
function buildMeetingRoom(prefix: string, roomLabel: string, roomX: number, roomY: number, opts?: { withDecoder?: boolean }) {
  const roomId = addRoom(roomLabel, roomX, roomY, ROOM_W, ROOM_H);

  // Subrooms relative to room top-left
  const tableId  = addRoom("Table",          20, 50, 320, 380, roomId);
  const bdId     = addRoom("Behind Display", 360, 50, 320, 380, roomId);
  const ueId     = addRoom("UC Engine",      700, 50, 320, 380, roomId);
  const dwId     = addRoom("Display Wall",  1040, 50, 360, 380, roomId);
  const ceilId   = addRoom("Ceiling",         20, 450, 700, 220, roomId);
  const outId    = addRoom("Outside Room",    20, 690, 1380, 240, roomId);

  // Devices — positions relative to their subroom parents
  const laptop = addDevice({
    key: `${prefix}-laptop`, label: "Client Laptop", deviceType: "computer",
    templateId: "c0a80101-0027-4000-8000-000000000039",
    x: 30, y: 60, parentId: tableId,
    ports: [
      { label: "HDMI Out", signal: "hdmi", dir: "output", connector: "hdmi" },
      { label: "USB-C",    signal: "usb",  dir: "bidirectional", connector: "usb-c" },
      { label: "Ethernet", signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "AC Power", signal: "power", dir: "input", connector: "iec" },
    ],
  });

  const touch = addDevice({
    key: `${prefix}-touch`, label: "Touch Panel (TS-1070)", deviceType: "computer",
    manufacturer: "Crestron", modelNumber: "TS-1070-B-S",
    x: 30, y: 230, parentId: tableId,
    ports: [
      { label: "USB", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "LAN", signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "PoE Power", signal: "power", dir: "input", connector: "rj45" },
    ],
  });

  const conv = addDevice({
    key: `${prefix}-hdconv`, label: "HD-CONV-USB-300", deviceType: "converter",
    manufacturer: "Crestron", modelNumber: "HD-CONV-USB-300",
    x: 30, y: 60, parentId: bdId,
    ports: [
      { label: "HDMI In",   signal: "hdmi", dir: "input", connector: "hdmi" },
      { label: "Audio In",  signal: "analog-audio", dir: "input", connector: "trs-eighth" },
      { label: "DC",        signal: "power", dir: "input", connector: "barrel-dc" },
      { label: "USB Out",   signal: "usb", dir: "output", connector: "usb-a" },
      { label: "Audio Out", signal: "analog-audio", dir: "output", connector: "trs-eighth" },
      { label: "LAN",       signal: "ethernet", dir: "bidirectional", connector: "rj45" },
    ],
  });

  const ue = addDevice({
    key: `${prefix}-ue`, label: "UC Engine (Optiplex 7080)", deviceType: "computer",
    manufacturer: "Dell", modelNumber: "Optiplex 7080 Micro",
    x: 30, y: 60, parentId: ueId,
    ports: [
      { label: "USB 1", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "USB 2", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "USB 3", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "USB 4", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "USB 5", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "USB 6", signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "HDMI",  signal: "hdmi", dir: "output", connector: "hdmi" },
      { label: "DP 1",  signal: "displayport", dir: "output", connector: "displayport" },
      { label: "DP 2",  signal: "displayport", dir: "output", connector: "displayport" },
      { label: "LAN",   signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "DC",    signal: "power", dir: "input", connector: "barrel-dc" },
    ],
  });

  // Optional decoder under UC Engine (Colab 1 only)
  let decoder: ReturnType<typeof addDevice> | null = null;
  if (opts?.withDecoder) {
    decoder = addDevice({
      key: `${prefix}-decoder`, label: "DM-NVX-D30 (Decoder 3)", deviceType: "converter",
      manufacturer: "Crestron", modelNumber: "DM-NVX-D30",
      x: 30, y: 240, parentId: ueId,
      ports: [
        { label: "LAN",   signal: "ethernet", dir: "bidirectional", connector: "rj45" },
        { label: "Audio", signal: "analog-audio", dir: "output", connector: "trs-eighth" },
        { label: "HDMI",  signal: "hdmi", dir: "output", connector: "hdmi" },
        { label: "IR",    signal: "ir", dir: "output", connector: "trs-eighth" },
        { label: "COM",   signal: "serial", dir: "bidirectional", connector: "phoenix" },
        { label: "DC",    signal: "power", dir: "input", connector: "barrel-dc" },
      ],
    });
  }

  const tv = addDevice({
    key: `${prefix}-tv`, label: "55\" LCD (LG 55UR640S0TD)", deviceType: "tv",
    templateId: "c0a80101-0004-4000-8000-000000000004",
    manufacturer: "LG", modelNumber: "55UR640S0TD",
    x: 20, y: 60, parentId: dwId,
    ports: [
      { label: "HDMI IN 1",   signal: "hdmi", dir: "input", connector: "hdmi" },
      { label: "HDMI IN 2",   signal: "hdmi", dir: "input", connector: "hdmi" },
      { label: "HDMI IN 3",   signal: "hdmi", dir: "input", connector: "hdmi" },
      { label: "AUDIO OUT",   signal: "analog-audio", dir: "output", connector: "trs-eighth" },
      { label: "USB",         signal: "usb", dir: "bidirectional", connector: "usb-a" },
      { label: "LAN",         signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "RF",          signal: "rf", dir: "input", connector: "f-type" },
      { label: "RS-232",      signal: "serial", dir: "bidirectional", connector: "phoenix" },
      { label: "PWR",         signal: "power", dir: "input", connector: "iec" },
    ],
  });

  const vbar = addDevice({
    key: `${prefix}-vbar`, label: "Video Bar (PanaCast 50)", deviceType: "camera",
    templateId: "c0a80101-0001-4000-8000-000000000001",
    manufacturer: "Jabra", modelNumber: "PanaCast 50",
    x: 20, y: 240, parentId: dwId,
    ports: [
      { label: "USB B",     signal: "usb", dir: "bidirectional", connector: "usb-b" },
      { label: "USB C",     signal: "usb", dir: "bidirectional", connector: "usb-c" },
      { label: "AUDIO IN",  signal: "analog-audio", dir: "input", connector: "trs-eighth" },
      { label: "AUDIO OUT", signal: "analog-audio", dir: "output", connector: "trs-eighth" },
      { label: "LAN",       signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "DC",        signal: "power", dir: "input", connector: "barrel-dc" },
    ],
  });

  const occ = addDevice({
    key: `${prefix}-occ`, label: "Occupancy Sensor (CEN-ODT-C-POE)", deviceType: "control-processor",
    manufacturer: "Crestron", modelNumber: "CEN-ODT-C-POE",
    x: 250, y: 50, parentId: ceilId,
    ports: [
      { label: "LAN", signal: "ethernet", dir: "bidirectional", connector: "rj45" },
    ],
  });

  const light = addDevice({
    key: `${prefix}-light`, label: "Light Bar (T3R-770-LB)", deviceType: "control-processor",
    manufacturer: "Crestron", modelNumber: "T3R-770-LB-B-S",
    x: 30, y: 60, parentId: outId,
    ports: [
      { label: "USB", signal: "usb", dir: "output", connector: "usb-a" },
    ],
  });

  const booking = addDevice({
    key: `${prefix}-booking`, label: "Room Booking (TSS-770)", deviceType: "control-processor",
    manufacturer: "Crestron", modelNumber: "TSS-770-B-S",
    x: 350, y: 60, parentId: outId,
    ports: [
      { label: "USB", signal: "usb", dir: "input", connector: "usb-a" },
      { label: "LAN", signal: "ethernet", dir: "bidirectional", connector: "rj45" },
    ],
  });

  // Connections (intra-room)
  connect(`${prefix}-laptop`, "HDMI Out", `${prefix}-hdconv`, "HDMI In", "hdmi");
  connect(`${prefix}-laptop`, "USB-C",    `${prefix}-hdconv`, "Audio In", "usb"); // simplified
  connect(`${prefix}-hdconv`, "USB Out",  `${prefix}-ue`,     "USB 1",    "usb");
  connect(`${prefix}-ue`,     "HDMI",     `${prefix}-tv`,     "HDMI IN 1","hdmi");
  connect(`${prefix}-ue`,     "USB 5",    `${prefix}-vbar`,   "USB B",    "usb");
  connect(`${prefix}-light`,  "USB",      `${prefix}-booking`,"USB",      "usb");
}

// Arrival room — much simpler: Signage Player + TV + Wall Plate + Laptop
function buildArrival(roomX: number, roomY: number) {
  const roomId = addRoom("14.01 Arrival", roomX, roomY, ROOM_W, ROOM_H);
  const dwId = addRoom("Display Wall", 50, 50, 1400, 700, roomId);

  const laptop = addDevice({
    key: "arr-laptop", label: "Client Laptop", deviceType: "computer",
    templateId: "c0a80101-0027-4000-8000-000000000039",
    x: 30, y: 350, parentId: dwId,
    ports: [
      { label: "HDMI Out", signal: "hdmi", dir: "output", connector: "hdmi" },
      { label: "USB-C",    signal: "usb",  dir: "bidirectional", connector: "usb-c" },
    ],
  });

  const wp = addDevice({
    key: "arr-wp", label: "Wall Plate (WP/01-01)", deviceType: "wall-plate",
    x: 320, y: 350, parentId: dwId,
    ports: [
      { label: "HDMI In",  signal: "hdmi", dir: "input",  connector: "hdmi" },
      { label: "HDMI Out", signal: "hdmi", dir: "output", connector: "hdmi" },
    ],
  });

  const sp = addDevice({
    key: "arr-sp", label: "Signage Player (BrightSign XD235)", deviceType: "media-player",
    templateId: "c0a80101-0034-4000-8000-000000000052",
    manufacturer: "BrightSign", modelNumber: "XD235",
    x: 600, y: 60, parentId: dwId,
    ports: [
      { label: "LAN",        signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "HDMI Out",   signal: "hdmi", dir: "output", connector: "hdmi" },
      { label: "Audio Out",  signal: "analog-audio", dir: "output", connector: "trs-eighth" },
      { label: "IR",         signal: "ir", dir: "output", connector: "trs-eighth" },
      { label: "DC",         signal: "power", dir: "input", connector: "barrel-dc" },
    ],
  });

  const tv = addDevice({
    key: "arr-tv", label: "55\" LCD (LG 55UR640S0TD)", deviceType: "tv",
    templateId: "c0a80101-0004-4000-8000-000000000004",
    manufacturer: "LG", modelNumber: "55UR640S0TD",
    x: 950, y: 60, parentId: dwId,
    ports: [
      { label: "HDMI IN 1", signal: "hdmi", dir: "input", connector: "hdmi" },
      { label: "HDMI IN 2", signal: "hdmi", dir: "input", connector: "hdmi" },
      { label: "AUDIO OUT", signal: "analog-audio", dir: "output", connector: "trs-eighth" },
      { label: "USB",       signal: "usb",  dir: "bidirectional", connector: "usb-a" },
      { label: "LAN",       signal: "ethernet", dir: "bidirectional", connector: "rj45" },
      { label: "PWR",       signal: "power", dir: "input", connector: "iec" },
    ],
  });

  connect("arr-laptop", "HDMI Out", "arr-wp", "HDMI In", "hdmi");
  connect("arr-wp",     "HDMI Out", "arr-tv", "HDMI IN 2", "hdmi");
  connect("arr-sp",     "HDMI Out", "arr-tv", "HDMI IN 1", "hdmi");
}

// Build the six rooms in a 3x2 grid -------------------------------
buildArrival(0, 0);
buildMeetingRoom("r07", "14.07 4P Meeting Rm 1", ROOM_W + ROOM_GAP_X, 0);
buildMeetingRoom("r14", "14.14 Colab 2",         (ROOM_W + ROOM_GAP_X) * 2, 0);
buildMeetingRoom("r16", "14.16 4P Meeting Rm 2", 0, ROOM_H + ROOM_GAP_Y);
buildMeetingRoom("r23", "14.23 4P Meeting Rm 3", ROOM_W + ROOM_GAP_X, ROOM_H + ROOM_GAP_Y);
buildMeetingRoom("r24", "14.24 Colab 1",         (ROOM_W + ROOM_GAP_X) * 2, ROOM_H + ROOM_GAP_Y, { withDecoder: true });

const schematic = {
  version: 34,
  name: "Zurich Fitout - Meeting Rms (one-shot)",
  nodes,
  edges,
};

writeFileSync("./demo-zurich.json", JSON.stringify(schematic, null, 2));
console.log(`Wrote ${nodes.length} nodes, ${edges.length} edges -> demo-zurich.json`);
