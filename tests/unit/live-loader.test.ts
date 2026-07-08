import { describe, expect, it } from "vitest";
import { caretLoader, CaretLoaderError } from "../../packages/core/src/loader";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import type { CaretRequestContext } from "../../packages/core/src/runtime/request-context";
import type { StorageAdapter, UploadHandler } from "../../packages/core/src/types";

/**
 * caretLoader() must honor Astro's LiveLoader contract (stable in Astro 6):
 *   - loadEntry({ filter: { id }, collection }) → LiveDataEntry | undefined | { error }
 *   - loadCollection({ collection })            → LiveDataCollection | { error }
 * It reads from the request-scoped StorageAdapter, so every call runs inside a
 * request context (the integration's `order: 'pre'` middleware provides one).
 */

function contextWith(adapter: StorageAdapter, editor = false): CaretRequestContext {
  return {
    adapter,
    uploadHandler: {} as unknown as UploadHandler, // unused by the loader
    sessionId: null,
    demoMode: false,
    editor,
  };
}

function seededAdapter(): InMemoryAdapter {
  const adapter = new InMemoryAdapter();
  adapter.preload("pages", [
    { id: "home", data: { title: "Home" } },
    { id: "about", data: { title: "About" } },
  ]);
  return adapter;
}

/** Adapter whose reads always throw, to exercise the loader's error path. */
const throwingAdapter = {
  getEntry: () => Promise.reject(new Error("boom")),
  listEntries: () => Promise.reject(new Error("boom")),
} as unknown as StorageAdapter;

describe("caretLoader", () => {
  it("names the loader caret:<collection>", () => {
    expect(caretLoader("pages").name).toBe("caret:pages");
  });

  describe("loadEntry", () => {
    it("returns { id, data } (+ cache tags) for an existing entry", async () => {
      const loader = caretLoader("pages");
      const result = await runWithRequestContext(contextWith(seededAdapter()), () =>
        loader.loadEntry({ filter: { id: "home" }, collection: "pages" }),
      );
      expect(result).toEqual({
        id: "home",
        data: { title: "Home" },
        cacheHint: { tags: ["caret:pages", "caret:pages::home"] },
      });
    });

    it("returns undefined for a missing entry", async () => {
      const loader = caretLoader("pages");
      const result = await runWithRequestContext(contextWith(seededAdapter()), () =>
        loader.loadEntry({ filter: { id: "missing" }, collection: "pages" }),
      );
      expect(result).toBeUndefined();
    });

    it("returns { error } when the adapter throws", async () => {
      const loader = caretLoader("pages");
      const result = await runWithRequestContext(contextWith(throwingAdapter), () =>
        loader.loadEntry({ filter: { id: "home" }, collection: "pages" }),
      );
      expect(result).toMatchObject({ error: expect.any(CaretLoaderError) });
    });

    it("returns { error } when called outside a request context", async () => {
      const result = await caretLoader("pages").loadEntry({
        filter: { id: "home" },
        collection: "pages",
      });
      expect(result).toMatchObject({ error: expect.any(CaretLoaderError) });
      // The missing-context error is wrapped as the cause of the load error.
      const cause = (result as { error: CaretLoaderError }).error.cause as Error;
      expect(cause.message).toMatch(/StorageAdapter not initialized/);
    });
  });

  describe("loadCollection", () => {
    it("returns all entries mapped to { id, data }", async () => {
      const loader = caretLoader("pages");
      const result = await runWithRequestContext(contextWith(seededAdapter()), () =>
        loader.loadCollection({ collection: "pages" }),
      );
      expect(result).toEqual({
        entries: [
          {
            id: "about",
            data: { title: "About" },
            cacheHint: { tags: ["caret:pages", "caret:pages::about"] },
          },
          {
            id: "home",
            data: { title: "Home" },
            cacheHint: { tags: ["caret:pages", "caret:pages::home"] },
          },
        ],
        cacheHint: { tags: ["caret:pages"] },
      });
    });

    it("returns { error } when the adapter throws", async () => {
      const loader = caretLoader("pages");
      const result = await runWithRequestContext(contextWith(throwingAdapter), () =>
        loader.loadCollection({ collection: "pages" }),
      );
      expect(result).toMatchObject({ error: expect.any(CaretLoaderError) });
    });
  });

  // Astro 7 live-collection cacheHint: published content is tagged so a publish
  // can purge it by tag; editor/draft requests must stay fresh, so they carry
  // NO cache hint (and instead get stega-encoded for click-to-edit).
  describe("cacheHint (Astro 7)", () => {
    it("omits cacheHint for an editor request (drafts stay fresh)", async () => {
      const loader = caretLoader("pages");
      const entry = await runWithRequestContext(contextWith(seededAdapter(), true), () =>
        loader.loadEntry({ filter: { id: "home" }, collection: "pages" }),
      );
      expect(entry).not.toHaveProperty("cacheHint");

      const collection = await runWithRequestContext(contextWith(seededAdapter(), true), () =>
        loader.loadCollection({ collection: "pages" }),
      );
      expect(collection).not.toHaveProperty("cacheHint");
      for (const e of (collection as { entries: unknown[] }).entries) {
        expect(e).not.toHaveProperty("cacheHint");
      }
    });

    it("tags published entries and the collection for purge-by-tag", async () => {
      const loader = caretLoader("pages");
      const collection = await runWithRequestContext(contextWith(seededAdapter()), () =>
        loader.loadCollection({ collection: "pages" }),
      );
      expect(collection).toMatchObject({ cacheHint: { tags: ["caret:pages"] } });
    });
  });
});
