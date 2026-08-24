/**
 * Default header color for newly placed devices (#354).
 *
 * Two settings, resolved in this order:
 *   1. the project override — `SchematicFile.defaultDeviceHeaderColor`, travels with the file
 *   2. the app preference — localStorage, applies to every project on this machine
 *   3. neither, which leaves the device with no `headerColor` at all so DeviceNode keeps
 *      painting the theme's `--color-surface` the way it always has
 *
 * The resolved color is *stamped* onto each device as it is created rather than consulted
 * at paint time, so changing either setting never recolors devices already on the canvas.
 */

/** App-level preference — an editor preference, not document data. */
export const DEFAULT_DEVICE_HEADER_COLOR_KEY = "easyschematic-default-header-color";

/** Swatch a header-color picker shows when nothing is set. Matches the neutral gray the
 *  device editor's picker has always opened on. */
export const HEADER_COLOR_SWATCH_FALLBACK = "#4b5563";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Narrow an untrusted value (a loaded schematic file, a localStorage string) to a CSS hex
 * color, lowercased and always in the 6-digit `#rrggbb` form — `<input type="color">`
 * rejects the 3-digit shorthand and would show black instead. Anything else — a token, a
 * `javascript:` string, a number — resolves to undefined and falls through to the next
 * level of the precedence chain.
 */
export function normalizeHeaderColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!HEX_COLOR.test(trimmed)) return undefined;
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return trimmed;
}

/** Project override beats app preference beats the built-in surface color (undefined). */
export function resolveDefaultDeviceHeaderColor(
  projectDefault: string | undefined,
  appDefault: string | undefined,
): string | undefined {
  return normalizeHeaderColor(projectDefault) ?? normalizeHeaderColor(appDefault);
}

export function loadAppDefaultHeaderColor(): string | undefined {
  try {
    return normalizeHeaderColor(localStorage.getItem(DEFAULT_DEVICE_HEADER_COLOR_KEY));
  } catch {
    return undefined;
  }
}

export function saveAppDefaultHeaderColor(color: string | undefined): void {
  try {
    const normalized = normalizeHeaderColor(color);
    if (normalized) localStorage.setItem(DEFAULT_DEVICE_HEADER_COLOR_KEY, normalized);
    else localStorage.removeItem(DEFAULT_DEVICE_HEADER_COLOR_KEY);
  } catch {
    // Storage full or unavailable — the in-memory choice still applies this session.
  }
}
