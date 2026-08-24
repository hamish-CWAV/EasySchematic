/**
 * Connection drag: the ghost preview and the release resolve the same port (#366).
 *
 * Dylan's report: a drag could paint the coloured ghost onto a port and then do nothing
 * on release unless the cursor crept closer. The two sides had drifted apart — the ghost
 * snapped anywhere inside a 30-unit radius, but the release path resolved its port with
 * document.elementFromPoint, i.e. only when the cursor sat literally on the ~10-unit
 * handle. connectSnap holds the one radius and the one decision both now call, so these
 * cases pin the rule rather than either caller's copy of it.
 *
 * Geometry below is a stripped port column at the real 16-px row pitch, with the seeded
 * fixture's handle ids (bidirectional ports own "<port>-in"/"<port>-out", and several
 * plain port ids end in those same tokens).
 */
import { describe, it, expect, vi } from "vitest";
import {
  CONNECT_SNAP_RADIUS,
  closestHandleWithinRadius,
  isConnectableDevice,
  resolveConnectTarget,
  resolveRelease,
  type ReleaseGesture,
  type SnapHandle,
} from "../connectSnap";

/** Projector's left-hand input column: two ports, one row apart. */
const PROJECTOR: SnapHandle[] = [
  { nodeId: "device-proj", handleId: "proj-hdmi-in", x: 400, y: 200 },
  { nodeId: "device-proj", handleId: "proj-sdi-in", x: 400, y: 216 },
];

/** Switcher's right-hand column, well clear of the projector. A bidirectional port
 *  contributes both faces; "hub-usb-in" is a plain port whose id merely ends in -in. */
const SWITCHER: SnapHandle[] = [
  { nodeId: "device-sw", handleId: "sw-net-1-in", x: 100, y: 200 },
  { nodeId: "device-sw", handleId: "sw-net-1-out", x: 180, y: 200 },
  { nodeId: "device-sw", handleId: "hub-usb-in", x: 100, y: 216 },
];

const ALL = [...PROJECTOR, ...SWITCHER];
const ORIGIN = { nodeId: "device-laptop", handleId: "laptop-hdmi-out" };

describe("isConnectableDevice", () => {
  const NONE: ReadonlySet<string> = new Set();

  it("accepts a device that is on canvas", () => {
    expect(isConnectableDevice({ id: "device-proj", type: "device" }, NONE)).toBe(true);
  });

  it("skips everything that isn't a device", () => {
    expect(isConnectableDevice({ id: "stub-label-3", type: "stubLabel" }, NONE)).toBe(false);
    expect(isConnectableDevice({ id: "room-1", type: "room" }, NONE)).toBe(false);
  });

  it("skips a virtual patch panel, whose ports are no longer drawn", () => {
    // setPanelOffCanvas hides the panel but React Flow keeps its handle bounds at the
    // position it last occupied — connecting there would wire a device nobody can see.
    const panel = { id: "device-pp1", type: "device", hidden: true, data: { offCanvas: true } };
    expect(isConnectableDevice(panel, NONE)).toBe(false);
  });

  it("skips an auto-inserted adapter that renders as an invisible placeholder", () => {
    const adapter = { id: "device-adapter-7", type: "device" };
    expect(isConnectableDevice(adapter, new Set(["device-adapter-7"]))).toBe(false);
  });
});

describe("closestHandleWithinRadius", () => {
  it("finds a port anywhere inside the snap radius, not just under the cursor", () => {
    // 25 units out — the ghost snapped here already; the release must agree.
    const hit = closestHandleWithinRadius(400 - 25, 200, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-hdmi-in");
  });

  it("returns nothing past the radius", () => {
    const hit = closestHandleWithinRadius(400 - (CONNECT_SNAP_RADIUS + 1), 200, ALL, ORIGIN);
    expect(hit).toBeNull();
  });

  it("includes the rim, matching React Flow's own inclusive bound", () => {
    const hit = closestHandleWithinRadius(400 - CONNECT_SNAP_RADIUS, 200, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-hdmi-in");
  });

  it("picks the nearer of two ports one row apart", () => {
    // Row pitch is 16, so a cursor at y=214 is inside the radius of both.
    const hit = closestHandleWithinRadius(400, 214, PROJECTOR, ORIGIN);
    expect(hit?.handleId).toBe("proj-sdi-in");
  });

  it("never snaps a drag back onto the handle it started from", () => {
    const withOrigin = [...ALL, { nodeId: "device-laptop", handleId: "laptop-hdmi-out", x: 300, y: 300 }];
    const hit = closestHandleWithinRadius(300, 300, withOrigin, ORIGIN);
    expect(hit).toBeNull();
  });

  it("distinguishes the two faces of a bidirectional port", () => {
    expect(closestHandleWithinRadius(105, 200, SWITCHER, ORIGIN)?.handleId).toBe("sw-net-1-in");
    expect(closestHandleWithinRadius(175, 200, SWITCHER, ORIGIN)?.handleId).toBe("sw-net-1-out");
  });
});

describe("resolveConnectTarget", () => {
  it("prefers the port under the cursor over a marginally nearer neighbour", () => {
    // Cursor sits on the SDI row but a hair closer to the HDMI centre.
    const hit = resolveConnectTarget(400, 207, { nodeId: "device-proj", handleId: "proj-sdi-in" }, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-sdi-in");
  });

  it("falls back to the radius search when the cursor is over open canvas", () => {
    const hit = resolveConnectTarget(400 - 22, 200, null, ALL, ORIGIN);
    expect(hit?.handleId).toBe("proj-hdmi-in");
  });

  it("resolves to nothing while the cursor is over the drag's own origin handle", () => {
    // React Flow refuses that release, so the ghost must not offer a neighbour instead.
    const withOrigin = [...PROJECTOR, { nodeId: "device-laptop", handleId: "laptop-hdmi-out", x: 400, y: 190 }];
    const hit = resolveConnectTarget(400, 190, ORIGIN, withOrigin, ORIGIN);
    expect(hit).toBeNull();
  });

  it("resolves to nothing over a handle that is not a connectable port", () => {
    // Stub tag handles never reach the candidate list; releasing on one does nothing,
    // and a green ghost pointing at a nearby port would be a lie.
    const hit = resolveConnectTarget(400, 205, { nodeId: "stub-label-3", handleId: "tag" }, ALL, ORIGIN);
    expect(hit).toBeNull();
  });

  it("returns the candidate's own centre so the ghost lands on the port it will use", () => {
    const hit = resolveConnectTarget(410, 210, null, ALL, ORIGIN);
    expect(hit).toEqual({ nodeId: "device-proj", handleId: "proj-sdi-in", x: 400, y: 216 });
  });
});

describe("resolveRelease", () => {
  /** A drag from the laptop's HDMI output, released 22 units short of the projector's
   *  HDMI input — the ghost is snapped and coloured there. */
  const gesture = (over: Partial<ReleaseGesture> = {}): ReleaseGesture => ({
    origin: ORIGIN,
    flowHandledConnect: false,
    reconnecting: false,
    pointerX: 400 - 22,
    pointerY: 200,
    handleUnderCursor: null,
    candidates: ALL,
    ...over,
  });

  const valid = () => true;
  const invalid = () => false;

  it("acts on the port the ghost snapped to, even over open canvas", () => {
    // The whole of #366: coloured ghost at 22 units, so the release must land there.
    expect(resolveRelease(gesture(), invalid)?.handleId).toBe("proj-hdmi-in");
  });

  it("stands down once React Flow has made the connection itself", () => {
    expect(resolveRelease(gesture({ flowHandledConnect: true }), invalid)).toBeNull();
  });

  it("stands down with no drag in flight", () => {
    expect(resolveRelease(gesture({ origin: null }), invalid)).toBeNull();
  });

  it("leaves ports on the drag's own device alone", () => {
    const sameDevice = gesture({
      origin: { nodeId: "device-proj", handleId: "proj-hdmi-in" },
      pointerX: 400,
      pointerY: 216,
      handleUnderCursor: { nodeId: "device-proj", handleId: "proj-sdi-in" },
    });
    expect(resolveRelease(sameDevice, invalid)).toBeNull();
  });

  it("never asks about validity on a fresh drag — that is the store's job in onConnect", () => {
    const isValid = vi.fn(() => false);
    resolveRelease(gesture(), isValid);
    expect(isValid).not.toHaveBeenCalled();
  });

  describe("re-routing an existing connection", () => {
    /** Dragging a connection's device end off "proj-hdmi-in" and onto a sibling port.
     *  React Flow fires the connect callbacks for this drag too, and the connect end
     *  runs before the reconnect end. */
    const reroute = (over: Partial<ReleaseGesture> = {}) =>
      gesture({ reconnecting: true, ...over });

    it("stays out of a re-route React Flow accepted, instead of duplicating it", () => {
      // Dropped straight on the switcher's input, a connection React Flow will make.
      // Acting here too would leave two identical connections and two undo steps.
      const dropped = reroute({
        pointerX: 100,
        pointerY: 200,
        handleUnderCursor: { nodeId: "device-sw", handleId: "sw-net-1-in" },
      });
      expect(resolveRelease(dropped, valid)).toBeNull();
    });

    it("invents nothing when the release lands on open canvas — that gesture disconnects", () => {
      // 22 units from the projector's input but on no handle at all: React Flow deletes
      // the connection in onReconnectEnd, and a new connection here would cost a second
      // undo to unpick one gesture.
      expect(resolveRelease(reroute(), invalid)).toBeNull();
      expect(resolveRelease(reroute(), valid)).toBeNull();
    });

    it("still raises the adapter prompt for a re-route onto a mismatched port", () => {
      const dropped = reroute({
        pointerX: 100,
        pointerY: 216,
        handleUnderCursor: { nodeId: "device-sw", handleId: "hub-usb-in" },
      });
      expect(resolveRelease(dropped, invalid)?.handleId).toBe("hub-usb-in");
    });
  });
});
