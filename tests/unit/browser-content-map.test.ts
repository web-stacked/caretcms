import { describe, expect, it } from "vitest";
import { readEntryTitle } from "../../packages/core/static/cms/editor/content-map.js";

describe("content map", () => {
  it("reads the display title the entries API sends and ignores malformed payloads", () => {
    expect(readEntryTitle({ entries: [{ id: "01-mara", title: "Mara Ellison", data: {} }] })).toBe("Mara Ellison");
    expect(readEntryTitle({ entries: [{ id: "x", title: "" }] })).toBeNull();
    expect(readEntryTitle({ entries: [] })).toBeNull();
    expect(readEntryTitle({ entries: "invalid" })).toBeNull();
    expect(readEntryTitle(null)).toBeNull();
  });
});
