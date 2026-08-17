/**
 * Discoverability cue for manual cable path editing (#275). Adding path handles
 * lives behind a right-click that users had no way to find, so a selected cable
 * shows a small hint pill pointing at the context menu. The hint only appears
 * when exactly one cable is selected (a multi-select is a bulk operation, not
 * path editing) and disappears once the cable carries any user-placed handle —
 * at that point the user has found the feature.
 */
export function showPathEditHint(opts: {
  /** This cable is selected AND it is the only selected cable. */
  soleSelected: boolean;
  /** A routed path exists to anchor the hint to. */
  hasRoute: boolean;
  /** The cable already has user-placed handles (manual or stub-leg waypoints). */
  hasOwnWaypoints: boolean;
  /** Direct-attach edges represent a physical plug-in — no cable run to shape. */
  directAttach: boolean;
}): boolean {
  return opts.soleSelected && opts.hasRoute && !opts.hasOwnWaypoints && !opts.directAttach;
}
