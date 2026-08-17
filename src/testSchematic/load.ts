/**
 * Loading the seeded test schematic (#307) into the running app.
 *
 * Two entry points, both landing on `importFromJSON`:
 *   - File ▸ Load Test Schematic, shown only in dev builds
 *   - `?fixture=test` on any URL, so a beta deploy can be seeded too
 *
 * The JSON is dynamically imported so it never rides in the initial bundle.
 */
import type { SchematicFile } from "../types";
import { useSchematicStore } from "../store";

/** URL query flag that seeds the fixture on load. */
export const FIXTURE_PARAM = "fixture";
export const FIXTURE_VALUE = "test";

/** Name the fixture carries, used to recognise it as already loaded. */
const FIXTURE_NAME = "EasySchematic Test Fixture";

/**
 * Ask before destroying work.
 *
 * There is no dirty tracking in the store, so "has something to lose" is
 * approximated by "the canvas has devices on it". Three cases skip the prompt
 * because nothing is at risk: an empty canvas, the auto-loaded demo, and the
 * fixture itself — reloading the fixture to reset the scene mid-test-pass is the
 * common case and must not nag.
 */
function confirmOverwrite(): boolean {
  const state = useSchematicStore.getState();
  const hasContent = state.nodes.some((n) => n.type === "device");
  if (!hasContent || state.isDemo || state.schematicName === FIXTURE_NAME) return true;
  return window.confirm(
    "Load the test schematic?\n\n" +
      `This replaces the schematic you have open ("${state.schematicName}") — ` +
      "the same as File ▸ Open. Anything unsaved is lost.",
  );
}

/**
 * Replace the current schematic with the test fixture. Returns false if the user
 * declined the overwrite prompt.
 *
 * The import is cloned first: `importFromJSON` migrates and snaps in place, so
 * handing it the module-cached JSON would leave a mutated fixture behind for
 * every later load in the same session.
 */
export async function loadTestSchematic(): Promise<boolean> {
  if (!confirmOverwrite()) return false;
  const mod = await import("./schematic.json");
  const data = structuredClone(mod.default) as unknown as SchematicFile;
  useSchematicStore.getState().importFromJSON(data);
  return true;
}

/**
 * Seed the fixture when the URL asks for it, then strip the flag so a reload
 * (or a share of the address bar) doesn't silently wipe the user's work again.
 *
 * The flag is stripped whether or not the load goes ahead — declining the prompt
 * means "don't load", and leaving the flag in place would re-ask on every reload.
 */
export function loadTestSchematicFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get(FIXTURE_PARAM) !== FIXTURE_VALUE) return;
  params.delete(FIXTURE_PARAM);
  const query = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  void loadTestSchematic();
}
