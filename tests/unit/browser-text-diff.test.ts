import { describe, expect, it } from "vitest";
import { changedPart } from "../../packages/core/static/cms/editor/text-diff.js";

describe("changedPart", () => {
  it("keeps short texts whole", () => {
    expect(changedPart("Old title", "New title")).toEqual({ before: "Old title", after: "New title" });
  });

  it("cuts a long sentence down to the words that changed, with a word of context", () => {
    expect(changedPart("Rufen Sie uns an oder schreiben Sie uns. Mo–Fr 8–17 Uhr.", "Rufen Sie uns an oder schreiben Sie uns. Mo–Sa 8–18 Uhr."))
      .toEqual({ before: "…uns. Mo–Fr 8–17 Uhr.", after: "…uns. Mo–Sa 8–18 Uhr." });
  });

  it("marks both ends when the change is in the middle", () => {
    expect(changedPart("We prune trees in the winter months, every year, by hand.", "We prune trees in the spring months, every year, by hand."))
      .toEqual({ before: "…the winter months,…", after: "…the spring months,…" });
  });

  it("returns texts with nothing in common as they are", () => {
    expect(changedPart("One two three four five six seven", "Eight nine ten eleven twelve thirteen fourteen"))
      .toEqual({ before: "One two three four five six seven", after: "Eight nine ten eleven twelve thirteen fourteen" });
  });

  it("handles one side empty", () => {
    expect(changedPart("", "A whole new sentence written here today")).toEqual({ before: "", after: "A whole new sentence written here today" });
  });
});
