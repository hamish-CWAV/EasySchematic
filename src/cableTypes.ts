import type { ConnectorType, Port, SignalType } from "./types";
import { SIGNAL_LABELS, CONNECTOR_LABELS } from "./types";
import {
  CONNECTOR_TO_CABLE,
  CONNECTOR_ACCEPTS,
  HYBRID_CABLE_FAMILY,
  matesNatively,
  needsAdapter,
  resolvePortGender,
} from "./connectorTypes";

/** Maps each signal type to a physical cable type label for pack lists (legacy fallback) */
export const SIGNAL_TO_CABLE: Record<SignalType, string> = {
  sdi: "SDI",
  genlock: "SDI",
  composite: "Composite",
  "component-video": "Component Video",
  "s-video": "S-Video",
  ndi: "Ethernet",
  dante: "Ethernet",
  avb: "Ethernet",
  ethernet: "Ethernet",
  srt: "Ethernet",
  hdbaset: "Ethernet",
  "analog-audio": "Analog Audio",
  "speaker-level": "Speaker",
  bluetooth: "Wireless",
  digilink: "DigiLink",
  aes: "AES",
  rs422: "DB9",
  rs485: "Phoenix",
  serial: "DB9",
  hdmi: "HDMI",
  displayport: "DisplayPort",
  usb: "USB",
  fiber: "Fiber",
  thunderbolt: "Thunderbolt",
  vga: "VGA",
  dvi: "DVI",
  power: "Power",
  "power-l1": "Cam-Lok",
  "power-l2": "Cam-Lok",
  "power-l3": "Cam-Lok",
  "power-neutral": "Cam-Lok",
  "power-ground": "Cam-Lok",
  gpio: "GPIO",
  "contact-closure": "Phoenix",
  dmx: "DMX",
  madi: "MADI",
  midi: "MIDI",
  tally: "Tally",
  spdif: "S/PDIF",
  adat: "ADAT",
  ultranet: "Ultranet",
  aes50: "AES50",
  stageconnect: "StageConnect",
  wordclock: "Word Clock",
  aes67: "Ethernet",
  ydif: "Ethernet",
  rf: "BNC",
  st2110: "Ethernet",
  artnet: "Ethernet",
  sacn: "Ethernet",
  ir: "IR Emitter Cable",
  timecode: "BNC",
  gigaace: "Ethercon",
  dx5: "Ethercon",
  slink: "Ethercon",
  soundgrid: "Ethercon",
  fibreace: "Fiber - opticalCON",
  dsnake: "Ethercon",
  dxlink: "Ethercon",
  gps: "BNC",
  dars: "BNC",
  rtmp: "Ethernet",
  rtsp: "Ethernet",
  "mpeg-ts": "Ethernet",
  ebus: "Phoenix",
  "control-voltage": "Phoenix",
  "extron-exp": "Cat6",
  pots: "Phone (RJ11)",
  "blu-link": "BLU link",
  cresnet: "Cresnet",
  nlight: "Ethernet",
  sensor: "Sensor",
  custom: "Other",
};

const HYBRID_FAMILY_ORDER = Object.keys(HYBRID_CABLE_FAMILY) as ConnectorType[];

/**
 * Cable label for a run whose two ends terminate differently but mate with no adapter
 * in between — e.g. "LC to SC Fiber". Returns undefined unless both ends sit in the
 * same hybrid family (see HYBRID_CABLE_FAMILY) and actually mate natively.
 *
 * Without this the pack list names the cable after ONE end, and whoever packs an
 * "LC Fiber" for an LC↔SC run arrives with a cable that only lands at one device.
 *
 * The two ends are ordered by HYBRID_CABLE_FAMILY declaration order rather than by drag
 * direction: a hybrid cord is a symmetric part, so LC→SC and SC→LC have to collapse onto
 * one pack-list row instead of billing as two SKUs. (Adapter labels stay directional — an
 * adapter is directional hardware with a male and a female end.) Declaration order runs
 * commonplace → specialty, so it reads as "LC to opticalCON Fiber"; sorting the labels
 * alphabetically instead would file opticalCON between LC and SC.
 */
export function hybridCableLabel(
  a: ConnectorType | undefined,
  b: ConnectorType | undefined,
): string | undefined {
  if (!a || !b || a === b) return undefined;
  const family = HYBRID_CABLE_FAMILY[a];
  if (!family || HYBRID_CABLE_FAMILY[b] !== family) return undefined;
  if (!matesNatively(a, b)) return undefined;
  // "LC Fiber" → "LC"; the family word is appended once at the end.
  const end = (c: ConnectorType): string => {
    const cable = CONNECTOR_TO_CABLE[c];
    return cable.endsWith(` ${family}`) ? cable.slice(0, -family.length - 1) : cable;
  };
  const [first, second] =
    HYBRID_FAMILY_ORDER.indexOf(a) <= HYBRID_FAMILY_ORDER.indexOf(b) ? [a, b] : [b, a];
  return `${end(first)} to ${end(second)} ${family}`;
}

/**
 * Derive cable type from ports and signal type.
 * Prefers connector-based lookup; falls back to signal-based for legacy data.
 */
export function getCableType(
  sourcePort: Port | undefined,
  targetPort: Port | undefined,
  signalType: SignalType,
): string {
  // Multicable trunk: derive from channel count + signal type
  const multicablePort = sourcePort?.isMulticable ? sourcePort : targetPort?.isMulticable ? targetPort : undefined;
  if (multicablePort) {
    const count = multicablePort.channelCount ?? 0;
    const connector = multicablePort.connectorType;
    if (connector === "socapex") {
      return `Socapex (${count}-Ch ${SIGNAL_LABELS[signalType]})`;
    }
    return `${count}-Ch ${SIGNAL_LABELS[signalType]}`;
  }

  const src = sourcePort?.connectorType;
  const tgt = targetPort?.connectorType;

  if (src && tgt && src !== tgt) {
    // Adapter-needed connection: label as adapter cable
    if (needsAdapter(src, tgt)) {
      const srcLabel = CONNECTOR_LABELS[src];
      const tgtLabel = CONNECTOR_LABELS[tgt];
      return `${srcLabel} to ${tgtLabel} Adapter`;
    }
    // Natively-mating ends that terminate differently: one hybrid cord, both ends named.
    const hybrid = hybridCableLabel(src, tgt);
    if (hybrid) return hybrid;
    // Native combo: prefer the more specific (accepted) connector for cable label
    if (CONNECTOR_ACCEPTS[src]?.native?.includes(tgt)) {
      return CONNECTOR_TO_CABLE[tgt] || SIGNAL_TO_CABLE[signalType];
    }
    if (CONNECTOR_ACCEPTS[tgt]?.native?.includes(src)) {
      return CONNECTOR_TO_CABLE[src] || SIGNAL_TO_CABLE[signalType];
    }
  }

  // Default: use source connector
  const connector = src ?? tgt;
  if (connector) {
    const cable = CONNECTOR_TO_CABLE[connector];
    if (cable) {
      const suffix = sameGenderSuffix(sourcePort, targetPort);
      return suffix ? `${cable} ${suffix}` : cable;
    }
  }
  return SIGNAL_TO_CABLE[signalType];
}

/**
 * Returns the cable's own gender suffix ("M-M" or "F-F") when both endpoints share a gender
 * — the case where a standard M-F cable won't work. A cable plug is always the opposite
 * gender of the port it mates with (male plug → female socket), so two female ports demand
 * an M-M cable and two male ports demand an F-F cable. Returns undefined for normal M-F
 * runs, for mismatched or genderless connectors, or when gender can't be confidently resolved.
 */
function sameGenderSuffix(sourcePort: Port | undefined, targetPort: Port | undefined): string | undefined {
  const srcG = resolvePortGender(sourcePort);
  const tgtG = resolvePortGender(targetPort);
  if (!srcG || !tgtG || srcG !== tgtG) return undefined;
  // Cable ends are opposite gender to the ports they plug into.
  return srcG === "male" ? "F-F" : "M-M";
}
