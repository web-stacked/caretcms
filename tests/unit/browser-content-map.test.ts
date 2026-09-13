import { describe, expect, it } from "vitest";
import { readOverrideData } from "../../packages/core/static/cms/editor/content-map.js";

describe("inline content map response boundary", () => {
  it("returns only object entry data", () => {
    expect(readOverrideData({ entries: [{ data: { hero: { headline: "Saved" } } }] }))
      .toEqual({ hero: { headline: "Saved" } });
    expect(readOverrideData({ entries: [{ data: [] }] })).toBeNull();
    expect(readOverrideData({ entries: [] })).toBeNull();
    expect(readOverrideData({ entries: "invalid" })).toBeNull();
    expect(readOverrideData(null)).toBeNull();
  });
});
