import { describe, expect, it } from "vitest";
import {
  normalizePendingSelection,
  normalizeSyncMessage,
} from "../../packages/core/static/cms/editor/sync.js";

describe("inline editor synchronization messages", () => {
  it("normalizes supported field selections before selector or navigation use", () => {
    expect(normalizeSyncMessage({
      type: "cms:field-selected",
      collection: "pages",
      id: "home",
      field: "hero.title",
      previewPath: "/about",
      source: "studio",
      embedded: true,
      ignored: "value",
    })).toEqual({
      type: "cms:field-selected",
      collection: "pages",
      id: "home",
      field: "hero.title",
      previewPath: "/about",
      source: "studio",
      embedded: true,
    });
  });

  it("accepts content changes while preserving delete messages with null data", () => {
    expect(normalizeSyncMessage({
      type: "cms:saved",
      collection: "pages",
      id: "home",
      data: { title: "Saved" },
      studioPath: "/admin/cms/pages/home",
    })).toMatchObject({ type: "cms:saved", data: { title: "Saved" } });
    expect(normalizeSyncMessage({
      type: "cms:deleted", collection: "posts", id: "old-post", data: null,
    })).toEqual({
      type: "cms:deleted", collection: "posts", id: "old-post", data: null,
    });
  });

  it("rejects malformed and unsupported messages", () => {
    expect(normalizeSyncMessage(null)).toBeNull();
    expect(normalizeSyncMessage({ type: "cms:field-selected", collection: "pages", id: "home" }))
      .toBeNull();
    expect(normalizeSyncMessage({ type: "cms:saved", collection: "", id: "home", data: {} }))
      .toBeNull();
    expect(normalizeSyncMessage({ type: "cms:saved", collection: "pages", id: "home", data: [] }))
      .toBeNull();
    expect(normalizeSyncMessage({ type: "cms:execute", collection: "pages", id: "home" }))
      .toBeNull();
  });

  it("validates persisted selection handoffs and finite timestamps", () => {
    expect(normalizePendingSelection({
      collection: "pages", id: "about", field: "title", savedAt: 123,
    })).toEqual({ collection: "pages", id: "about", field: "title", savedAt: 123 });
    expect(normalizePendingSelection({
      collection: "pages", id: "about", field: "", savedAt: 123,
    })).toBeNull();
    expect(normalizePendingSelection({
      collection: "pages", id: "about", field: "title", savedAt: Infinity,
    })).toBeNull();
  });
});
