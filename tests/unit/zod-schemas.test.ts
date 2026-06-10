import { describe, it, expect } from "vitest";
import { z } from "zod";
import { schemaFromZod, schemasFromZod } from "../../packages/zod/src/index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const props = (s: Record<string, unknown>) => s.properties as Record<string, any>;

describe("schemaFromZod", () => {
  it("maps a basic object and promotes descriptions to field labels", () => {
    const s = schemaFromZod(
      z.object({
        title: z.string().describe("Title"),
        excerpt: z.string().describe("Excerpt"),
      }),
    );
    expect(s.type).toBe("object");
    expect(props(s).title).toMatchObject({ type: "string", title: "Title" });
    expect(props(s).excerpt.title).toBe("Excerpt");
  });

  it("represents dates as string + format:date (raw z.toJSONSchema throws here)", () => {
    expect(props(schemaFromZod(z.object({ date: z.coerce.date() }))).date).toMatchObject({
      type: "string",
      format: "date",
    });
    // plain z.date() too
    expect(props(schemaFromZod(z.object({ when: z.date() }))).when).toMatchObject({
      type: "string",
      format: "date",
    });
  });

  it("carries custom widget hints from .meta({ format })", () => {
    const s = schemaFromZod(
      z.object({
        cover: z.string().meta({ format: "image" }),
        body: z.string().meta({ format: "html" }),
      }),
    );
    expect(props(s).cover.format).toBe("image");
    expect(props(s).body.format).toBe("html");
  });

  it("marks optional fields by omitting them from required", () => {
    const s = schemaFromZod(z.object({ title: z.string(), cover: z.string().optional() }));
    expect(s.required).toEqual(["title"]);
  });

  it("handles arrays of strings", () => {
    expect(props(schemaFromZod(z.object({ tags: z.array(z.string()).default([]) }))).tags).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  it("lets an explicit .meta({ title }) win over the description", () => {
    const s = schemaFromZod(z.object({ a: z.string().describe("desc").meta({ title: "Explicit" }) }));
    expect(props(s).a.title).toBe("Explicit");
  });

  it("drops the $schema preamble", () => {
    expect(schemaFromZod(z.object({ a: z.string() })).$schema).toBeUndefined();
  });

  it("rejects a non-object root", () => {
    expect(() => schemaFromZod(z.string())).toThrow(/must be a Zod object/);
  });

  it("applies a caller override after the built-in date handling", () => {
    const s = schemaFromZod(z.object({ slug: z.string() }), {
      override: ({ jsonSchema }) => {
        if (jsonSchema.type === "string" && !jsonSchema.format) jsonSchema.format = "uri";
      },
    });
    expect(props(s).slug.format).toBe("uri");
  });
});

describe("schemasFromZod", () => {
  it("derives a JSON-Schema map keyed by collection name", () => {
    const out = schemasFromZod({
      blog: z.object({ title: z.string().describe("Title") }),
      page: z.object({ headline: z.string().describe("Headline") }),
    });
    expect(Object.keys(out)).toEqual(["blog", "page"]);
    expect(props(out.blog).title.title).toBe("Title");
    expect(props(out.page).headline.title).toBe("Headline");
  });
});
