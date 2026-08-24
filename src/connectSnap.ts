// One radius, one rule, for the whole connection drag (#366).
//
// A drag has two independent consumers deciding "which port is the cursor on":
// the ghost preview line the app draws itself, and React Flow's own drop handling
// (`connectionRadius` + the release in XYHandle). When they used separate copies of
// the number — and separate ways of picking the port — a drag could paint a coloured
// ghost at a distance where releasing did nothing, so the user had to creep closer
// before the connection took. Both now read CONNECT_SNAP_RADIUS and both resolve the
// target through resolveConnectTarget, so if the ghost snaps, the release lands.
//
// Re-routing an existing connection is React Flow's own gesture and keeps its own,
// narrower rule — resolveRelease says why, and the ghost follows the same rule there so
// it still can't promise more than the release will do.
//
// Kept free of store, React Flow and DOM imports so the decision is testable on its own.

/** Distance (in flow units, i.e. before zoom) at which a drag snaps to a port handle.
 *  Must be passed to React Flow as `connectionRadius` — that prop is the drop side of
 *  this same rule. */
export const CONNECT_SNAP_RADIUS = 30;

/** The parts of a node that decide whether a drag may land on its ports. */
export type ConnectableNodeShape = {
  id: string;
  type?: string;
  hidden?: boolean;
  /** Device data carries `offCanvas`; the other node kinds carry their own shapes. */
  data?: unknown;
};

/**
 * Can a drag land on this node's ports?
 *
 * Only devices carry ports, and only devices that are actually drawn can take a
 * connection. React Flow keeps the handle bounds and last position of a node it has
 * stopped rendering, so without this filter a search would find phantom ports: a
 * virtual patch panel leaves a full port column sitting in the empty patch of canvas it
 * used to occupy, and an auto-inserted adapter renders as a 1x1 invisible placeholder
 * mid-connection with all of its handles piled on one point. Neither can hold a
 * connection — the router drops both from its node set, and setPanelOffCanvas refuses to
 * make a wired panel virtual precisely because its connections would have nowhere to
 * land — so neither should attract the ghost or the release (#366).
 */
export function isConnectableDevice(
  node: ConnectableNodeShape,
  hiddenAdapterIds: ReadonlySet<string>,
): boolean {
  if (node.type !== "device") return false;
  const offCanvas = (node.data as { offCanvas?: unknown } | undefined)?.offCanvas;
  if (node.hidden || offCanvas) return false;
  return !hiddenAdapterIds.has(node.id);
}

/** A port handle the cursor could land on, positioned at its centre in flow space. */
export type SnapHandle = {
  nodeId: string;
  handleId: string;
  x: number;
  y: number;
};

/** The handle a drag started from — never a target for its own drag. */
export type SnapOrigin = { nodeId: string; handleId: string | null };

function isOrigin(nodeId: string, handleId: string, origin: SnapOrigin | undefined): boolean {
  return !!origin && origin.nodeId === nodeId && origin.handleId === handleId;
}

/**
 * Nearest handle whose centre is within `radius` of the pointer, or null.
 *
 * The bound is inclusive to match React Flow's own `getClosestHandle`, which skips a
 * handle only when `distance > connectionRadius`; an exclusive `<` here would put the
 * ghost one sub-pixel behind the drop on a dead-on hit at the rim.
 */
export function closestHandleWithinRadius(
  x: number,
  y: number,
  candidates: readonly SnapHandle[],
  origin?: SnapOrigin,
  radius: number = CONNECT_SNAP_RADIUS,
): SnapHandle | null {
  let best: SnapHandle | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (isOrigin(c.nodeId, c.handleId, origin)) continue;
    const dx = c.x - x;
    const dy = c.y - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= radius && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * The port a drag is on, given the pointer position and whichever handle is literally
 * under the cursor (null when the cursor is over the canvas, a device body, a label…).
 *
 * A handle under the cursor wins outright — React Flow does the same, because a port
 * you are pointing straight at should beat a neighbour whose centre happens to be a
 * pixel nearer. Everything else falls back to the radius search. Two cases deliberately
 * resolve to nothing rather than to a nearby port, because React Flow would refuse the
 * release there and the ghost must not promise otherwise: pointing at the drag's own
 * origin handle, and pointing at a handle that is not a connectable port at all (a stub
 * tag's, say, which never appears among the candidates).
 */
export function resolveConnectTarget(
  pointerX: number,
  pointerY: number,
  handleUnderCursor: { nodeId: string; handleId: string } | null,
  candidates: readonly SnapHandle[],
  origin?: SnapOrigin,
  radius: number = CONNECT_SNAP_RADIUS,
): SnapHandle | null {
  if (handleUnderCursor) {
    if (isOrigin(handleUnderCursor.nodeId, handleUnderCursor.handleId, origin)) return null;
    return (
      candidates.find(
        (c) => c.nodeId === handleUnderCursor.nodeId && c.handleId === handleUnderCursor.handleId,
      ) ?? null
    );
  }
  return closestHandleWithinRadius(pointerX, pointerY, candidates, origin, radius);
}

/** Everything the release backstop needs to know about how a drag ended. */
export type ReleaseGesture = {
  /** The handle the drag started from, or null when no drag is in flight. */
  origin: SnapOrigin | null;
  /** React Flow already made the connection itself — the backstop must stay out. */
  flowHandledConnect: boolean;
  /** This drag is re-routing an existing connection, not making a new one. */
  reconnecting: boolean;
  /** Pointer position at the release, in flow units. */
  pointerX: number;
  pointerY: number;
  handleUnderCursor: { nodeId: string; handleId: string } | null;
  candidates: readonly SnapHandle[];
  radius?: number;
};

/**
 * The port a release should act on, or null to leave the gesture alone.
 *
 * For a fresh connection drag this is simply "wherever the ghost snapped" — that is the
 * whole point of #366. A re-route is a different gesture, though: React Flow owns it
 * from end to end, re-wiring the connection through onReconnect or deleting it in
 * onReconnectEnd when the release found no port. It also fires the plain connect
 * callbacks along the way, and the connect end runs *before* the reconnect end, so a
 * backstop that acted on every release would double every successful re-route and turn
 * a deliberate disconnect over open canvas into a connection to whatever port happened
 * to be within the radius. So a re-route keeps the narrower rule: the cursor has to be
 * literally on a port, and the connection has to be one React Flow refused — which is
 * exactly the adapter case the backstop exists for.
 *
 * `isValidConnection` is only consulted on the re-route path, so callers can build the
 * connection lazily.
 */
export function resolveRelease(
  gesture: ReleaseGesture,
  isValidConnection: (target: SnapHandle) => boolean,
): SnapHandle | null {
  const { origin, flowHandledConnect, reconnecting, handleUnderCursor, candidates } = gesture;
  if (!origin || flowHandledConnect) return null;
  if (reconnecting && !handleUnderCursor) return null;
  const target = resolveConnectTarget(
    gesture.pointerX,
    gesture.pointerY,
    handleUnderCursor,
    candidates,
    origin,
    gesture.radius,
  );
  if (!target) return null;
  // A port on the drag's own device: the store refuses those anyway (bar patch-panel
  // front-to-front, which React Flow connects on its own), and running them through
  // onConnect would offer an adapter between two ports of one device.
  if (target.nodeId === origin.nodeId) return null;
  if (reconnecting && isValidConnection(target)) return null;
  return target;
}
