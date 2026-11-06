import { describe, expect, it } from "vitest";
import { entryDisplayTitle, humanizeEntryId, inferTitleField } from "../../packages/core/src/runtime/entry-title";
import { registerCollectionSchema, resolveCollectionStudioConfig } from "../../packages/core/src/runtime/schema-registry";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

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

describe("title fields", () => {
  it("prefers a page's title-like fields over a quoted person's name, and never a suffixed copy", () => {
    expect(entryDisplayTitle("pages", "home", { name: "Priya S.", name_2: "Dan W.", headline: "Bread worth getting up early for" }, {}))
      .toBe("Bread worth getting up early for");
    expect(entryDisplayTitle("pages", "home", { name_2: "Dan W.", quote: "Flaky" }, {})).toBe("Home");
  });

  it("infers the title field from a schema: a usual title field, else the first required plain string", () => {
    const string = { type: "string" };
    expect(inferTitleField({ type: "object", properties: { pubDate: string, title: string }, required: ["title"] })).toBe("title");
    expect(inferTitleField({ type: "object", properties: { role: string, name: string } })).toBe("name");
    expect(inferTitleField({
      type: "object",
      properties: { photo: string, kind: { type: "string", enum: ["a"] }, when: { type: "string", format: "date" }, caption: string },
      required: ["photo", "kind", "when", "caption"],
    })).toBe("caption");
    expect(inferTitleField({ type: "object", properties: { price: { type: "number" } }, required: ["price"] })).toBeUndefined();
    expect(inferTitleField(undefined)).toBeUndefined();
  });

  it("resolves a collection's title field from its schema unless one is configured", async () => {
    const adapter = new InMemoryAdapter();
    registerCollectionSchema("trial_posts", { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, null);
    registerCollectionSchema("trial_team", { type: "object", properties: { name: { type: "string" } } }, null, { titleField: "role" });
    expect((await resolveCollectionStudioConfig(adapter, "trial_posts")).titleField).toBe("title");
    expect((await resolveCollectionStudioConfig(adapter, "trial_team")).titleField).toBe("role");
    expect((await resolveCollectionStudioConfig(adapter, "trial_none")).titleField).toBeUndefined();
  });
});
