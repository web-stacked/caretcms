import { describe, expect, it } from "vitest";
import {
  normalizeSectionsFromData,
  reorderByDrag,
  type Section,
} from "../../packages/core/static/cms/editor/section-controls/model.js";

const fallback: Section[] = [
  { id: "hero", key: "home.hero", enabled: true },
];

describe("inline section layout model", () => {
  it("falls back when layout data is malformed", () => {
    expect(normalizeSectionsFromData(null, fallback)).toBe(fallback);
    expect(normalizeSectionsFromData({ layout: { sections: "invalid" } }, fallback)).toBe(fallback);
    expect(normalizeSectionsFromData({ layout: { sections: [{ key: "unknown" }] } }, fallback))
      .toBe(fallback);
  });

  it("normalizes legacy keys and makes duplicate IDs unique", () => {
    expect(normalizeSectionsFromData({
      layout: {
        sections: [
          { id: "shared", key: "home.trust_badges", enabled: true },
          { id: "shared", key: "home.features", enabled: false, spacing_y: "spacious" },
        ],
      },
    }, fallback)).toEqual([
      { id: "shared", key: "home.logo_bar", enabled: true, spacing_y: undefined },
      { id: "shared-2", key: "home.features", enabled: false, spacing_y: "spacious" },
    ]);
  });

  it("returns the original order when a drag endpoint is missing", () => {
    const sections: Section[] = [
      { id: "hero", key: "home.hero", enabled: true },
      { id: "features", key: "home.features", enabled: true },
    ];
    expect(reorderByDrag({
      sections,
      sourceId: "missing",
      targetId: "features",
      placeAfter: true,
    })).toBe(sections);
  });
});
