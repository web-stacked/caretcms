import { describe, expect, it } from "vitest";
import { fillDefaults, getNestedValue, humanizeKey, setNestedValue, templateFromSchema } from "../../packages/core/static/cms/studio/field-model.js";
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

describe("validation messages", () => {
  it("uses singular and plural nouns for length and item limits", () => {
    const schema = {
      type: "object",
      properties: {
        one: { type: "string", minLength: 1 },
        many: { type: "string", maxLength: 2 },
        list: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    } as const;
    const messages = validateJsonSchema({ one: "", many: "abc", list: [] }, schema as never).map(issue => issue.message);
    expect(messages).toEqual([
      "Must contain at least 1 character",
      "Must contain at most 2 characters",
      "Must contain at least 1 item",
    ]);
  });
});

describe("fillDefaults", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      published: { type: "boolean" },
      seo: { type: "object", properties: { description: { type: "string" }, noindex: { type: "boolean" } } },
      details: { type: "array", items: { type: "object", properties: { label: { type: "string" }, note: { type: "string", default: "–" } } } },
      gallery: { type: "array", format: "image-gallery", items: { type: "object", properties: { src: { type: "string" }, alt: { type: "string" } } } },
    },
  };

  it("adds missing keys the form would render, including inside nested objects and list items", () => {
    const data = { title: "Kept", seo: { description: "Kept too" }, details: [{ label: "Medium" }], gallery: [{ src: "/a.png" }] };
    expect(fillDefaults(data, schema as never)).toEqual({
      title: "Kept",
      published: false,
      seo: { description: "Kept too", noindex: false },
      details: [{ label: "Medium", note: "–" }],
      gallery: [{ src: "/a.png" }],
    });
  });

  it("is stable, so a filled entry compares equal to itself after filling again", () => {
    const once = fillDefaults({ details: [{}] }, schema as never);
    expect(fillDefaults(structuredClone(once), schema as never)).toEqual(once);
  });
});
