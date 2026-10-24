import { describe, expect, it } from "vitest";
import { entryDisplayTitle, humanizeEntryId } from "../../packages/core/src/runtime/entry-title";

describe("entryDisplayTitle", () => {
  it("names a singleton by its collection", () => {
    expect(entryDisplayTitle("site", "global", { title: "Atlas" }, { label: "Site settings", singletonId: "global" })).toBe("Site settings");
    expect(entryDisplayTitle("site_config", "global", {}, { singletonId: "global" })).toBe("Site config");
  });

  it("prefers the configured title field, then the usual title fields, as plain text", () => {
    expect(entryDisplayTitle("gallery", "01", { caption: "Studio, <em>morning</em> light", title: "x" }, { titleField: "caption" })).toBe("Studio, morning light");
    expect(entryDisplayTitle("pages", "home", { hero: { title: "Nested" } }, { titleField: "hero.title" })).toBe("Nested");
    expect(entryDisplayTitle("team", "01-mara", { name: "Mara Ellison" }, {})).toBe("Mara Ellison");
    expect(entryDisplayTitle("faq", "q1", { question: "Fish &amp; chips?" }, {})).toBe("Fish & chips?");
  });

  it("falls back to a readable id", () => {
    expect(entryDisplayTitle("team", "01-mara", { name: "  " }, {})).toBe("01 mara");
    expect(entryDisplayTitle("pages", "about_us", null, { titleField: "headline" })).toBe("About us");
    expect(humanizeEntryId("ship-something-real")).toBe("Ship something real");
  });
});
