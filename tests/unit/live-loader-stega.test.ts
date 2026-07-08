import { describe, expect, it } from "vitest";
import { caretLoader } from "../../packages/core/src/loader";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import type { CaretRequestContext } from "../../packages/core/src/runtime/request-context";
import type { StorageAdapter, UploadHandler } from "../../packages/core/src/types";
import {
  hasStega,
  stegaClean,
  stegaDecode,
} from "../../packages/core/src/runtime/stega";

/**
 * Draft-mode stega: the loader hides each field's `collection::id::field` key
 * inside the value when (and only when) the request is from an editor. Visitors
 * get byte-identical plain data.
 */

function contextWith(
  adapter: StorageAdapter,
  editor: boolean,
): CaretRequestContext {
  return {
    adapter,
    uploadHandler: {} as unknown as UploadHandler,
    sessionId: null,
    demoMode: false,
    editor,
  };
}

function seededAdapter(): InMemoryAdapter {
  const adapter = new InMemoryAdapter();
  adapter.preload("pages", [
    { id: "home", data: { hero: { title: "Professional Websites" } } },
  ]);
  return adapter;
}

describe("caretLoader stega (draft mode)", () => {
  it("encodes the binding key into string fields for an editor", async () => {
    const loader = caretLoader("pages");
    const result = await runWithRequestContext(
      contextWith(seededAdapter(), true),
      () => loader.loadEntry({ filter: { id: "home" }, collection: "pages" }),
    );

    const title = (result as { data: { hero: { title: string } } }).data.hero.title;
    // Looks identical once cleaned...
    expect(stegaClean(title)).toBe("Professional Websites");
    // ...but carries the dot-path key, recoverable with no data-caret attribute.
    expect(hasStega(title)).toBe(true);
    expect(stegaDecode(title)).toBe("pages::home::hero.title");
  });

  it("returns plain, byte-identical data for a visitor (no editor)", async () => {
    const loader = caretLoader("pages");
    const result = await runWithRequestContext(
      contextWith(seededAdapter(), false),
      () => loader.loadEntry({ filter: { id: "home" }, collection: "pages" }),
    );

    expect(result).toEqual({
      id: "home",
      data: { hero: { title: "Professional Websites" } },
      // Published (non-editor) content carries Astro 7 cache tags for purge-by-tag.
      cacheHint: { tags: ["caret:pages", "caret:pages::home"] },
    });
    const title = (result as { data: { hero: { title: string } } }).data.hero.title;
    expect(hasStega(title)).toBe(false);
  });

  it("encodes collection entries only for editors", async () => {
    const loader = caretLoader("pages");

    const asEditor = await runWithRequestContext(
      contextWith(seededAdapter(), true),
      () => loader.loadCollection({ collection: "pages" }),
    );
    const editorTitle = (asEditor as { entries: { data: { hero: { title: string } } }[] })
      .entries[0].data.hero.title;
    expect(stegaDecode(editorTitle)).toBe("pages::home::hero.title");

    const asVisitor = await runWithRequestContext(
      contextWith(seededAdapter(), false),
      () => loader.loadCollection({ collection: "pages" }),
    );
    const visitorTitle = (asVisitor as { entries: { data: { hero: { title: string } } }[] })
      .entries[0].data.hero.title;
    expect(hasStega(visitorTitle)).toBe(false);
  });
});
