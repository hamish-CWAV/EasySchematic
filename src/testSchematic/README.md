# Seeded test schematic (#307)

One scene that already contains everything a manual test pass needs, so a
test-report item can name a starting state instead of describing how to build
one. Before this existed, three test rounds on 2026-08-16 spent more time
placing devices and setting port types than actually testing.

## Loading it

| Where | How |
| --- | --- |
| Local dev (`./start-dev.sh`) | **File ▸ Load Test Schematic** — shown only in dev builds |
| Any build, incl. beta | append `?fixture=test` to the URL, e.g. `https://beta.easyschematic.live/?fixture=test` |

Both replace the current schematic outright, exactly as File ▸ Open does. The
URL flag is stripped after loading, so a reload doesn't wipe your work a second
time.

## Files

| File | Role |
| --- | --- |
| `build.ts` | The fixture, as typed code. **Edit this.** |
| `schematic.json` | Generated output — what the app actually loads. Committed. |
| `load.ts` | The two app entry points |
| `run.ts` | The generator |
| `../__tests__/testSchematic.test.ts` | In-sync check + coverage guards |

```
npm run fixture:build    # regenerate schematic.json after editing build.ts
npm run fixture:check    # fail if the JSON has drifted (also enforced by npm test)
```

Device positions are computed from `deviceContentHeight`, the same height
contract `DeviceNode` renders to, so adding or removing ports re-flows the
layout instead of overlapping devices.

`COL_GAP` and `ROW_GAP` are deliberately generous (#368): the three adapter
benches below each pair their two devices in *adjacent* columns rather than
stacking them in one column, so the auto-inserted adapter lands in open
`COL_GAP` space instead of squeezing into a tight vertical gap — before this, a
test pass had to drag one device out of the way first. The same wide gaps give
a converted-to-stub connection's tag room to render without crowding its
neighbor.

`COL_GAP=320` isn't an arbitrary round number: `insertAdapterBetween` in
`store.ts` nudges an adapter that overlaps a neighboring device with
`pushLeft = other.position.x - adapterW(144) - MIN_GAP(80)`, so its single
nudge pass only clears that neighbor once the gap between the two paired
devices is at least `144 + 80 = 224px`. `COL_GAP` is set well past that floor
so an adapter lands with room on both sides rather than exactly at the edge of
clearing — `testSchematic.test.ts`'s `#368 adapter-bench spacing` guard pins
the 224px floor so a future layout change can't quietly re-stack a bench
without a test noticing. Column *order* within a room also isn't free: a
device with real wiring should sit in whichever column is nearest the room its
wires actually run to (see the comment above `rackRoom` in `build.ts`), or
widening the gaps here just makes cross-room runs longer instead of shorter.

## What it covers

Each of these is asserted by `testSchematic.test.ts` — if you remove one from
the fixture, a test fails rather than a test pass quietly losing coverage.

- **Fiber, all four terminations.** LC, SC, ST and opticalCON. LC↔SC is wired in
  both directions (the pack list must collapse those to one `2x LC to SC Fiber`
  row) and ST↔opticalCON is wired once. Every termination keeps a spare **input
  and output** the wired runs never touch, so any of the twelve mixed pairings
  can be drawn by hand without deleting a pre-wired run first.
- **Adapter auto-insert, both drag directions.** Three unwired benches:
  USB-A ↔ RJ45 (`USB Hub` ↔ `Core Switch`), XLR-3 ↔ 1/4" TRS
  (`FOH Console` ↔ `Playback Deck`), and Edison ↔ IEC
  (`Rack UPS` ↔ `Powered Speaker` / `Utility Bar`). The mirrored families are
  the regression guard the auto-insert pairings depend on.
- **Patch panel.** `PP-01` carries eight passthrough ports spanning Cat6,
  etherCON, BNC, XLR-3, LC fiber, two half-normalled TRS and a
  terminal-block/Phoenix pair, with front/rear connector and gender mismatches.
  Two circuits are patched end to end; the rest are free.
- **Rooms and the blank sentinel.** `main Hall` is mixed case on purpose — it is
  the only spelling that tells As-typed apart from Capitalize, so a
  caps-or-lowercase-only fixture silently fails to test the mode. `BOH Rack
  Room` exercises acronym-aware Capitalize and `TECH TABLE` proves As-typed
  leaves real caps alone. Two devices sit outside every room.
- **Label wrap and contrast.** Every device carries a header auxiliary row —
  the #249 dead-space bug is invisible without one, because `HEADER_BAND_MIN_PX`
  clamps an empty band. Labels run from `Amp` to
  `Christie Griffyn 4K35-RGB Laser Projector (House Left)`.
- **Owned gear in all three stock states.** Surplus (4 owned, 1 placed), exact
  (1/1) and short (1 owned, 2 placed). Without any owned gear the Devices
  report's Owned/Need columns don't render at all.
- **A device genuinely placed from a bundled template.** `BMD SDI→Audio 12G`
  (`device-21`, in TECH TABLE) carries a real `templateId` and ports cloned
  from `DEVICE_TEMPLATES` with `templatePortId` set — every other device in
  the fixture is synthetic, so without this one the device editor's
  template-family actions (Update as Custom, Save as Preset, Revert to
  Template) have nothing to render for. One of its ports is hidden relative
  to the template so it also opens dirty, reaching Revert to Template.

## Adding to it

Add the device to the right room's column list in `build.ts`, run
`npm run fixture:build`, and — if it covers a new scenario — add the assertion
to `testSchematic.test.ts` and the bullet above. Keep every device's
`deviceType` to a value in `deviceTypeCategories.ts`, or it falls out of every
report category bucket.

Extending the fixture is the right move whenever a change needs a scenario it
doesn't cover — cheaper than writing the setup into a test report, which buys one
pass and costs every pass after it.
