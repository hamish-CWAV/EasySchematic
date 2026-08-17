import { describe, it, expect } from "vitest";
import { showPathEditHint } from "../pathEditHint";

const base = {
  soleSelected: true,
  hasRoute: true,
  hasOwnWaypoints: false,
  directAttach: false,
};

describe("showPathEditHint", () => {
  it("shows for a single selected, routed cable with no handles", () => {
    expect(showPathEditHint(base)).toBe(true);
  });

  it("hides when the cable is not the sole selection", () => {
    expect(showPathEditHint({ ...base, soleSelected: false })).toBe(false);
  });

  it("hides before a route exists (nowhere to anchor the hint)", () => {
    expect(showPathEditHint({ ...base, hasRoute: false })).toBe(false);
  });

  it("hides once the cable already carries user-placed handles", () => {
    expect(showPathEditHint({ ...base, hasOwnWaypoints: true })).toBe(false);
  });

  it("hides on direct-attach edges (no cable run to shape)", () => {
    expect(showPathEditHint({ ...base, directAttach: true })).toBe(false);
  });
});
