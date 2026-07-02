# Wall Elevations Feature — Feasibility Study & Implementation Plan

**Status:** Feasibility assessment / proposal — no code changes yet.
**Scope:** Scaled 2D wall-elevation drawings (e.g. wall-mounted display + bracket + gear
behind the display + power/data plates + touch panels at set heights from the floor),
exportable to PDF / PNG / SVG / DXF like existing surfaces.

---

## 1. Verdict

**Highly feasible — the architecture already anticipates this feature.** EasySchematic is
not a single-canvas app: it is a multi-surface editor where the signal-flow canvas,
rack-elevation pages, and print-sheet pages share one project file, one zustand store, one
undo system, and one export stack. A wall-elevation surface is a natural third page type,
and the existing **Rack Builder is ~80% of the architectural blueprint**: it is already a
mm-accurate, to-scale, drag-and-drop elevation editor with front/rear/side views, bespoke
SVG rendering, and pure-vector PDF export.

Key enablers already in the codebase:

| Need | Already exists | Where |
| --- | --- | --- |
| Page/tab system for alternate surfaces | `SchematicPage` union + `pages[]` + `PageTabs` | `src/types.ts:709`, `src/store.ts:619`, `src/components/PageTabs.tsx` |
| Real-world physical dimensions on devices | `heightMm/widthMm/depthMm/weightKg` on templates & instances, backed by DB columns | `src/types.ts:279–285, 509–512`, `api/migrations/0022_add_dimension_fields.sql` |
| mm→px scale for to-scale rendering | `PX_PER_MM` constant used by rack + print-sheet renderers | `src/rackUtils.ts:99` |
| To-scale drag/drop/snap SVG editor | `RackRenderer` (zoom/pan, drag from sidebar, snap, collision) | `src/components/RackRenderer.tsx` |
| Devices shared by reference across surfaces | `RackDevicePlacement.deviceNodeId` links a rack slot to the schematic node | `src/types.ts:620` |
| Vector PDF of an elevation view | `rackPdf.ts` (`drawElevation`, `drawSideView`) in mm units | `src/rackPdf.ts:160, 445` |
| Paper sheets + title block composition | Print-sheet pages place view "viewports" on real paper sizes | `src/types.ts:685–707`, `src/printSheetPdf.ts` |
| Versioned file schema with migrations | `CURRENT_SCHEMA_VERSION = 41`, forward migrations | `src/migrations.ts:19` |
| CAD interop | Hand-rolled AutoCAD R2000 DXF writer (layers, polylines, text, hatches) | `src/dxfExport/` |
| Undo/redo & persistence of page data | Snapshots already clone `pages`; `pages` already serialises | `src/store.ts:808, 4847` |

What is genuinely **new** engineering (no precedent in the codebase):

1. **Dimension lines/strings** — heights from finished floor level (FFL), widths, offsets.
   Nothing in the app draws dimension annotations today.
2. **Wall/architectural context** — a wall rectangle with floor line, optional ceiling
   line, and a per-view scale (1:10 / 1:15 / 1:20).
3. **Elevation symbols** — front-view silhouettes for displays, brackets, wall plates,
   touch panels, speakers. Devices carry mm sizes but no front-view artwork (the
   face-plate/connector rendering used by racks is rack-face specific).

None of these are hard; they are additive drawing primitives on a surface pattern the
codebase already repeats twice.

## 2. What the target drawings contain (requirements)

From the reference CAD elevation sheets (typical AV integrator deliverables), a useful
elevation view needs:

- **Front elevation per wall/location**: wall boundary + floor line; display outline with
  screen/bezel; TV bracket behind the display (distinct outline); small devices mounted
  behind the display (control processor etc.), drawn dashed/ghosted; wall plates (GPO,
  data, HDMI, brush plates) below/behind the display; touch panels beside the display at a
  set height; optional "in ceiling space" callout boxes above.
- **Dimension strings**: heights from FFL to item centreline/underside (e.g. 300, 600,
  1100, 1800), display width/height, and horizontal offsets.
- **Leader labels**: make/model text pointing at each item.
- **Side elevation** (secondary): wall profile with the display's standoff depth.
- **View furniture**: view title + bubble number + per-view scale note; several views per
  sheet; standard title block.
- Content is repetitive across rooms — the same display + bracket + controller + plates
  arrangement recurs with minor height changes, which argues for presets/duplication
  rather than a heavyweight authoring flow.

## 3. Data model (proposed)

Add a third member to the page union (`src/types.ts:709`), mirroring
`RackElevationPage`:

```ts
export interface WallElevationPage {
  id: string;
  label: string;
  type: "wall-elevation";
  walls: WallData[];             // each wall = one named, scaled view
  placements: WallPlacement[];   // schematic devices placed on a wall
  fixtures: WallFixture[];       // non-schematic symbols: GPO/data plates, brackets, callouts
  dimensions: WallDimension[];   // manual dimension overrides/additions
}

export interface WallData {
  id: string;
  label: string;                 // "L1 Elevation", "Meeting Room North Wall"
  widthMm: number;               // drawn wall extent
  heightMm: number;              // FFL → top of view (ceiling optional marker)
  position: { x: number; y: number }; // layout position on the elevation page canvas
  linkedRoomId?: string;         // same pattern as RackData.linkedRoomId
  view: "front" | "side";
}

export interface WallPlacement {
  id: string;
  wallId: string;
  deviceNodeId: string;          // shared-by-reference with the schematic, like racks
  xMm: number;                   // left edge from wall datum
  yMm: number;                   // bottom edge above FFL
  layer: "surface" | "behind-display" | "in-wall" | "in-ceiling";
  anchor?: "bottom" | "centre";  // which point the height dimension reports
  mirrored?: boolean;
}

export interface WallFixture {   // library symbols that aren't schematic devices
  id: string;
  wallId: string;
  kind: "gpo" | "data-plate" | "av-plate" | "brush-plate" | "tv-bracket"
      | "conduit-stub" | "ceiling-callout" | "custom";
  label?: string;                // "OFE DGPO", "OFE Data-2", "Chief TS525TU"
  xMm: number; yMm: number;
  widthMm: number; heightMm: number;
}

export interface WallDimension {
  id: string;
  wallId: string;
  kind: "height-ffl" | "linear";
  targetId?: string;             // auto: follows a placement/fixture
  from?: { xMm: number; yMm: number };  // manual two-point dimension
  to?: { xMm: number; yMm: number };
  offsetMm?: number;             // dimension-line offset from the wall edge
}
```

Why this shape:

- **Devices by reference** (`deviceNodeId`) keeps elevation ↔ schematic in sync exactly as
  racks do: renames, swaps, and deletes propagate; cascading-delete follows the existing
  rack pattern (`store.ts` cascade on device removal). Pack list/BOM is untouched because
  placements are views of existing devices, not duplicates.
- **Fixtures are separate from devices** because plates/brackets often aren't (and
  shouldn't need to be) schematic nodes. But since GPO/data outlets are frequently *also*
  schematic devices, a fixture may optionally be created *from* a device template later.
- **Auto height dimensions** (`kind: "height-ffl"`) cover ~90% of what the reference
  drawings show, with manual two-point dimensions for the rest.
- Because `pages` already serialises (`store.ts:4847`) and undo snapshots already clone
  `pages` (`store.ts:808`), persistence, cloud sync, sharing, and undo/redo come along for
  free. Requires a schema bump to **v42** with an additive (no-op for old files)
  migration — standard procedure documented in `src/migrations.ts:5–12`.

## 4. Rendering approaches

### Option A — bespoke SVG renderer modelled on `RackRenderer` (recommended)

A `WallElevationRenderer` component: SVG canvas, own zoom/pan, HTML5 drag/drop from a
sidebar, `PX_PER_MM` world scale, snap helpers. This is exactly how both existing
non-schematic surfaces are built (`RackRenderer.tsx`, `PrintSheetRenderer.tsx`).

- Pros: full control over mm coordinates, dimension lines, snapping to real heights;
  the SVG scene graph maps 1:1 onto the jsPDF vector drawing and the DXF writer (proven by
  `RackFaceSVG` ↔ `rackPdf.ts` parity); consistent with codebase precedent; no React Flow
  coordinate/pixel impedance.
- Cons: selection/marquee/keyboard handling is hand-rolled (but `RackRenderer` already
  contains reusable patterns for all of it).

### Option B — second React Flow instance with elevation node types

Custom RF nodes for walls (as container nodes, like rooms) and items.

- Pros: free drag, selection, marquee, minimap.
- Cons: RF works in screen pixels, not mm — every position needs conversion; dimension
  lines and wall-relative snapping fight the framework; export would inherit the
  raster-capture pipeline rather than clean vectors; no precedent (neither rack nor print
  sheets use RF). **Not recommended.**

### Option C — no new editor; elevations as print-sheet viewport compositions only

Skip an editing surface: auto-generate an elevation from a room's devices with fixed
layout rules and only allow tweaks in a properties panel.

- Pros: minimal UI work.
- Cons: real drawings need free placement (touch panel left vs right of display, plates
  above/below); too rigid. Useful as an *auto-populate seed* (see §6), not as the whole
  feature.

**Recommendation: A**, with C's generator as a convenience layer on top.

## 5. Item graphics — box diagrams now, SVG symbols later

Three tiers, shippable incrementally:

1. **Dimension-driven boxes (MVP)** — any device with `widthMm`/`heightMm` renders as a
   to-scale rectangle + label, exactly like the reference drawings' simpler items. Screen
   devices get a bezel + screen-area treatment picked by device category. Devices missing
   dimensions prompt inline for width/height (already-editable fields on the device).
2. **Built-in stylised silhouettes** — a small hand-drawn SVG set keyed by
   category/`kind`: flat panel display, TV bracket (generic centre-plate + arms), touch
   panel, GPO (AU twin outlet), data plate, brush plate, camera/soundbar, in-ceiling
   speaker. Stored in-repo (like the built-in adapter templates in `src/deviceLibrary.ts`)
   or under `public/`. This covers the "standard items as simple box diagrams / provide
   SVGs as a resource" goal without any per-model artwork.
3. **Community-database artwork (later)** — an optional `elevationSvg` (or
   `elevationForm` enum) column on device templates, following the precedent of
   `facePlateLayout` (`src/types.ts:515`) and the additive D1 migration pattern
   (`api/migrations/0022` added the dimension columns). The community DB then grows
   real front-view artwork per model over time. Not needed for launch.

## 6. UX — how a user builds an elevation

**No multi-step wizard required.** The flow mirrors the Rack Builder, which users already
know:

1. **Create page**: `+` on the page-tab bar → "Wall Elevation" (alongside the existing
   rack/print-sheet buttons in `PageTabs.tsx`).
2. **Add a wall**: one small dialog (name, width × height mm, optional linked room) — a
   single step, same weight as the custom-rack dialog. Sensible default (e.g.
   3600 × 2700 mm).
3. **Place devices**: left sidebar (clone of `RackSidebar`) lists the schematic's devices
   — filtered to the linked room when set — with "placed/unplaced" state. Drag onto the
   wall; the item drops at true scale using its mm dimensions.
4. **Heights**: while dragging, a live readout shows the height above FFL; snap to
   configurable standard heights (e.g. 300 / 600 / 1100 / 1350 mm and display-centre
   heights), stored as user preferences. Selecting an item exposes exact X/Y mm fields in
   a properties strip — typing `1100` is the precision path, matching how installers spec
   it.
5. **Fixtures**: a second sidebar section ("Wall fittings") with the built-in symbols
   (GPO, data plate, bracket, callout). Same drag interaction.
6. **Behind-the-display gear**: drop onto the display → placement gets
   `layer: "behind-display"` and renders ghosted/dashed, drawn under the display outline
   (matches the reference drawings' hidden-line convention).
7. **Dimensions**: auto height-from-FFL dimension per item (toggleable per item),
   rendered as proper extension + dimension lines with arrowheads and mm text; a manual
   two-point dimension tool for widths/offsets.
8. **Optional generator ("Auto-populate")**: like the rack "Auto-populate from linked
   room" button — seed a wall from a room: display centred at a default height, bracket
   behind it, small devices behind the display, plates below. Because the reference
   sheets repeat the same arrangement across many rooms, add **"Duplicate wall"** +
   template-preset support to make the 10-meeting-rooms case fast.

A wizard only earns its place for the generator (step 8), and even that is one dialog with
three fields, not a multi-step flow.

## 7. Export

Follow the rack/print-sheet split — a standalone export plus composition onto sheets:

- **Vector PDF (MVP)**: new `wallElevationPdf.ts` modelled on `rackPdf.ts` (mm units,
  `fitMeet` viewBox mapping, jsPDF primitives). Draw functions factored to be callable
  standalone *and* from the print-sheet exporter — this is the established pattern
  (`printSheetPdf.ts` reuses `drawElevation`/`drawSideView` from `rackPdf.ts`).
- **Print-sheet composition (MVP or fast-follow)**: add
  `kind: "wall-elevation"` to `PrintViewport` (`src/types.ts:687`) so users compose
  multiple elevation views + rack views on one titled sheet at chosen paper sizes —
  reproducing the reference sheets (several scaled views + title block) almost exactly.
  Each viewport's implied scale (view mm ÷ paper mm) can be computed and printed as
  "Scale 1:N" under the view title.
- **PNG / SVG**: the editor is native SVG, so SVG export is a serialisation of the scene
  (plus the existing colour-freeze helper), and PNG is the existing html-to-image
  rasterise path (`src/exportUtils.ts`). Cheaper than the schematic's version because
  there's no React Flow DOM involved.
- **DXF (phase 3)**: the writer in `src/dxfExport/writer.ts` already emits everything an
  elevation needs (LWPOLYLINE, TEXT/MTEXT, ARC, HATCH, layers, dashed linetypes). Add an
  `emitWallElevation` module with layers like `EasySchematic-Elevation-Walls`,
  `-Devices`, `-Fixtures`, `-Dimensions`. Since the model is mm-native, this can be
  emitted at **1:1 real-world scale in mm** ($INSUNITS=4), which is genuinely more useful
  to builders/architects importing into CAD than the schematic's px-derived inches.
  Note: rack pages don't have DXF export today, so elevations would be first — the same
  module pattern applies.

## 8. Phasing & effort

| Phase | Contents | Relative effort |
| --- | --- | --- |
| **1 — MVP** | `WallElevationPage` type + store CRUD + migration v42; page tab & renderer (walls, device placements, box/bezel rendering, mm snap, properties strip); built-in fixture set (GPO/data/bracket/callout); auto FFL height dimensions; standalone vector PDF export | ≈ the original rack-builder MVP, minus the hard parts it already solved (scale maths, sidebar, drag patterns are copy-adapt). The new work concentrated in dimension rendering. |
| **2** | Print-sheet `wall-elevation` viewports; side-elevation view; manual two-point dimensions; leader labels; Auto-populate from room + duplicate-wall; PNG/SVG export | Small–medium; mostly composition of phase-1 pieces. |
| **3** | DXF emission; stylised silhouette expansion; community-DB `elevationSvg`/`elevationForm` column + submission UI; per-view printed scales & bubble numbering polish | Independent, each shippable alone. |

## 9. Risks & open questions

- **Dimension-line UX** is the only genuinely novel interaction; keep it mostly automatic
  (per-item FFL heights) to avoid building a full CAD dimensioning tool.
- **Missing dimensions in the device DB**: many community templates lack `heightMm`/
  `widthMm`. Mitigation: inline prompt on drop + the values feed back into the community
  DB via the existing submit-from-canvas flow.
- **Symbol quality/curation** for tier-2 silhouettes — keep the set small (~10 symbols)
  and generic; the label carries the model identity.
- **Fixture ↔ schematic duality** (a GPO that's also a schematic device): MVP treats
  fixtures as independent; a later link field can unify them. Decide before phase 3.
- **Scale semantics**: model space is always real mm; "scale" is a print/export-time
  property per viewport, not an editor property. This matches CAD conventions and avoids
  storing scale-dependent coordinates.

## 10. Bottom line

The feature fits the product's existing architecture unusually well: it is "Rack Builder
for walls" plus dimension lines and a small symbol library. Every hard infrastructure
problem — multi-page editing, mm-accurate rendering, shared device references, undo,
persistence/migrations, vector PDF, paper sheets with title blocks, DXF writing — is
already solved and battle-tested in the codebase, with clear file-level extension points
listed above. Recommended path: Option A renderer, three-tier graphics, no wizard beyond
a one-dialog wall creator and an optional auto-populate generator, phased as in §8.
