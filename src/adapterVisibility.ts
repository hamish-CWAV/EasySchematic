import type { DeviceData } from "./types";

/**
 * Whether an adapter reads as hidden given its own visibility override and the
 * global "hide adapters" toggle. 'default' defers to the global toggle; an
 * explicit force-hide/force-show always wins. Shared by DeviceContextMenu and
 * EdgeContextMenu so the two Hide/Show Adapter menu items can't drift (#312).
 */
export function isAdapterHidden(
  visibility: DeviceData["adapterVisibility"] | undefined,
  globalHideAdapters: boolean,
): boolean {
  const current = visibility ?? "default";
  return current === "force-hide" || (current === "default" && globalHideAdapters);
}

/** Flip an adapter's visibility override, reading 'default' per {@link isAdapterHidden}. */
export function toggleAdapterVisibility(
  visibility: DeviceData["adapterVisibility"] | undefined,
  globalHideAdapters: boolean,
): "force-show" | "force-hide" {
  return isAdapterHidden(visibility, globalHideAdapters) ? "force-show" : "force-hide";
}
