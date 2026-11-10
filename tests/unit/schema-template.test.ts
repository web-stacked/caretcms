import { describe, expect, it } from "vitest";
import { buildTemplate } from "../../packages/core/src/schema-utils";

describe("buildTemplate (a new entry in the Studio)", () => {
  // The blog template's post schema as Astro generates it.
  const post = {
    type: "object",
    required: ["title", "description", "pubDate"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      pubDate: { type: "string", format: "date-time" },
      updatedDate: { type: "string", format: "date-time" },
      heroImage: { type: "string" },
      draft: { type: "boolean", default: false },
      order: { type: "integer", minimum: -9007199254740991 },
    },
  };

  it("starts with required fields and defaults, leaving optional ones absent", () => {
    expect(buildTemplate(post)).toEqual({ title: "", description: "", pubDate: "", draft: false });
  });

  it("starts a required number at 0, or at a positive minimum", () => {
    expect(buildTemplate({ type: "object", required: ["a", "b"], properties: { a: { type: "integer", minimum: -9007199254740991 }, b: { type: "number", minimum: 3 } } }))
      .toEqual({ a: 0, b: 3 });
  });
});
