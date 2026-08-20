import { describe, expect, it } from "vitest";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { registerCollectionSchema } from "../../packages/core/src/runtime/schema-registry";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

const schema = {
  type: "object",
  required: ["title", "month", "images"],
  properties: {
    title: { type: "string", minLength: 1 },
    month: { type: "integer", minimum: 1, maximum: 12 },
    images: {
      type: "array",
      items: {
        type: "object",
        required: ["src", "width"],
        properties: {
          src: { type: "string" },
          width: { type: "integer", minimum: 1 },
        },
      },
    },
  },
} as const;

function adapter(): InMemoryAdapter {
  registerCollectionSchema("validated-artworks", schema, null);
  const storage = new InMemoryAdapter();
  storage.preload("validated-artworks", [{
    id: "one",
    data: { title: "One", month: 1, images: [{ src: "/one.png", width: 100 }] },
  }]);
  return storage;
}

describe("schema validation at the mutation boundary", () => {
  it("rejects constrained and nested invalid values without persisting them", async () => {
    const storage = adapter();
    const result = await executeMutation(storage, {
      type: "put_entry",
      collection: "validated-artworks",
      id: "one",
      data: { title: "One", month: 13, images: [{ src: "/one.png", width: 0 }] },
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    if (result.ok) return;
    expect(result.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "month", code: "too_big" }),
      expect.objectContaining({ path: "images.0.width", code: "too_small" }),
    ]));
    expect((await storage.getEntry("validated-artworks", "one"))?.data.month).toBe(1);
  });

  it("rejects missing required fields", async () => {
    const result = await executeMutation(adapter(), {
      type: "put_entry",
      collection: "validated-artworks",
      id: "one",
      data: { month: 2, images: [] },
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.body.issues).toContainEqual(expect.objectContaining({ path: "title", code: "required" }));
  });

  it("coerces inline numeric text using the field schema before validation", async () => {
    const storage = adapter();
    const result = await executeMutation(storage, {
      type: "save_field",
      collection: "validated-artworks",
      id: "one",
      field: "month",
      value: "12",
    });

    expect(result.ok).toBe(true);
    expect((await storage.getEntry("validated-artworks", "one"))?.data.month).toBe(12);
  });

  it("rejects an invalid inline value and leaves the revision unchanged", async () => {
    const storage = adapter();
    const result = await executeMutation(storage, {
      type: "save_field",
      collection: "validated-artworks",
      id: "one",
      field: "month",
      value: "13",
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await storage.getRevision("validated-artworks", "one")).toBe(0);
  });

  it("validates every reordered entry before writing any of the batch", async () => {
    const strictSchema = {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: { type: "string" } },
    } as const;
    registerCollectionSchema("strict-order", strictSchema, null);
    const storage = new InMemoryAdapter();
    storage.preload("strict-order", [
      { id: "one", data: { title: "One" } },
      { id: "two", data: { title: "Two" } },
    ]);

    const result = await executeMutation(storage, {
      type: "reorder_entries",
      collection: "strict-order",
      items: [
        { id: "one", order: 1 },
        { id: "two", order: 0 },
      ],
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect((await storage.getEntry("strict-order", "one"))?.data).toEqual({ title: "One" });
    expect((await storage.getEntry("strict-order", "two"))?.data).toEqual({ title: "Two" });
  });
});
