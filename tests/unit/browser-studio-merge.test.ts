import { describe, expect, it } from "vitest";
import { changedPaths, rebaseEdits } from "../../packages/core/static/cms/studio/merge.js";

describe("Studio conflict merge", () => {
  const base = { name: "Ring", price: 2899, specs: { stones: "Sapphire", weight: "4.2g" }, images: ["a.jpg"] };

  it("lists changed leaves with nested paths and treats arrays as values", () => {
    expect(changedPaths(base, { ...base, specs: { ...base.specs, stones: "Sapphire 1.2ct" }, images: ["a.jpg", "b.jpg"] }))
      .toEqual(["specs.stones", "images"]);
    expect(changedPaths(base, base)).toEqual([]);
  });

  it("keeps the other editor's untouched changes and applies only this form's edits", () => {
    const theirs = { ...base, specs: { ...base.specs, stones: "Sapphire 1.2ct" } };
    const mine = { ...base, specs: { ...base.specs, weight: "4.4g" } };
    const result = rebaseEdits(base, mine, theirs);
    expect(result.merged).toEqual({ ...base, specs: { stones: "Sapphire 1.2ct", weight: "4.4g" } });
    expect(result.theirChanges).toEqual(["specs.stones"]);
    expect(result.overlapping).toEqual([]);
  });

  it("lets this form win a field both editors changed and reports the overlap", () => {
    const result = rebaseEdits(base, { ...base, price: 2950 }, { ...base, price: 3100, name: "Halo ring" });
    expect(result.merged).toMatchObject({ price: 2950, name: "Halo ring" });
    expect(result.overlapping).toEqual(["price"]);
  });

  it("does not report an overlap when both editors made the same change", () => {
    expect(rebaseEdits(base, { ...base, price: 3000 }, { ...base, price: 3000 }).overlapping).toEqual([]);
  });

  it("applies field removals and additions from the form", () => {
    const mine: Record<string, unknown> = { ...base, note: "New" };
    delete mine.images;
    const result = rebaseEdits(base, mine, { ...base, price: 1 });
    expect(result.merged).toEqual({ name: "Ring", price: 1, specs: base.specs, note: "New" });
  });

  it("never mutates its inputs", () => {
    const theirs = structuredClone(base);
    rebaseEdits(base, { ...base, specs: { stones: "X", weight: "1g" } }, theirs);
    expect(theirs).toEqual(base);
  });
});
