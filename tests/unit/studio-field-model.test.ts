import { describe, expect, it } from "vitest";
import { getNestedValue, humanizeKey, setNestedValue, templateFromSchema } from "../../packages/core/static/cms/studio/field-model.js";
import { validateJsonSchema } from "../../packages/core/src/schema-utils";

describe("Studio templates", () => {
  it("creates independent copies of nested defaults for repeated rows", () => {
    const defaults = { labels: ["Original"], metadata: { description: "First\nSecond\n" } };
    const schema = { type: "object", default: defaults };
    const first = templateFromSchema(schema) as typeof defaults;
    const second = templateFromSchema(schema);
    first.labels.push("Added");
    first.metadata.description = "Changed";
    expect(second).toEqual(defaults);
    expect(defaults).toEqual({ labels: ["Original"], metadata: { description: "First\nSecond\n" } });
  });

  it("builds a valid nested row from enum, minimum, boolean, and array constraints", () => {
    const schema = { type: "object", required: ["size", "visibility", "enabled", "tags", "description"], properties: {
      size: { type: "integer", minimum: 1 },
      visibility: { type: "string", enum: ["private", "public"] },
      enabled: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      description: { type: "string", default: "First\nSecond\n" },
    } };
    expect(validateJsonSchema(templateFromSchema(schema), schema)).toEqual([]);
  });
});

describe("Studio nested field paths", () => {
  it("creates missing objects and arrays while setting a nested field", () => {
    const data: Record<string, unknown> = {};
    setNestedValue(data, "sections.0.heading", "Introduction");
    expect(data).toEqual({ sections: [{ heading: "Introduction" }] });
    expect(getNestedValue(data, "sections.0.heading")).toBe("Introduction");
  });

  it("replaces scalar path segments and returns undefined for missing paths", () => {
    const data: Record<string, unknown> = { hero: "legacy" };
    setNestedValue(data, "hero.image.alt", "Portrait");
    expect(data).toEqual({ hero: { image: { alt: "Portrait" } } });
    expect(getNestedValue(data, "hero.image.width")).toBeUndefined();
    expect(getNestedValue(null, "hero.image")).toBeUndefined();
  });
});

describe("Studio fallback labels", () => {
  it("expands common editing acronyms without overriding schema titles", () => {
    expect(humanizeKey("cta_label")).toBe("Call to action label");
    expect(humanizeKey("seo_url")).toBe("SEO URL");
    expect(humanizeKey("image_id")).toBe("Image ID");
  });
});
