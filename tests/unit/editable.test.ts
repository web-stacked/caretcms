import { describe, expect, it } from "vitest";
import { editable } from "../../packages/core/src/editable";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import type { CaretRequestContext } from "../../packages/core/src/runtime/request-context";
import type { StorageAdapter, UploadHandler } from "../../packages/core/src/types";
import {
  hasStega,
  stegaClean,
  stegaDecode,
} from "../../packages/core/src/runtime/stega";

function ctx(adapter: StorageAdapter, editor: boolean): CaretRequestContext {
  return {
    adapter,
    uploadHandler: {} as unknown as UploadHandler,
    sessionId: null,
    demoMode: false,
    editor,
  };
}

describe("editable()", () => {
  it("returns the inline default untouched for a visitor", async () => {
    const out = await runWithRequestContext(ctx(new InMemoryAdapter(), false), () =>
      editable("pages::home::hero_title", "Welcome"),
    );
    expect(out).toBe("Welcome");
  });

  it("overlays a stored value over the inline default", async () => {
    const a = new InMemoryAdapter();
    await a.writeEntry("pages", "home", { hero_title: "Saved Welcome" });
    const out = await runWithRequestContext(ctx(a, false), () =>
      editable("pages::home::hero_title", "Default Welcome"),
    );
    expect(out).toBe("Saved Welcome");
  });

  it("editor: stega-encodes a scalar with its binding key", async () => {
    const out = await runWithRequestContext(ctx(new InMemoryAdapter(), true), () =>
      editable("pages::home::hero_title", "Welcome"),
    );
    expect(stegaClean(out)).toBe("Welcome");
    expect(stegaDecode(out)).toBe("pages::home::hero_title");
  });

  it("editor: encodes every string leaf of an array with index+field keys", async () => {
    const items = [
      { title: "Fast", desc: "speedy" },
      { title: "SEO", desc: "found" },
    ];
    const out = (await runWithRequestContext(ctx(new InMemoryAdapter(), true), () =>
      editable("pages::home::features.items", items),
    )) as typeof items;

    expect(stegaClean(out[0].title)).toBe("Fast"); // visible content intact
    expect(stegaDecode(out[0].title)).toBe("pages::home::features.items.0.title");
    expect(stegaDecode(out[1].desc)).toBe("pages::home::features.items.1.desc");
  });

  it("overlay merges a single saved array-item field, keeping the rest default", async () => {
    const a = new InMemoryAdapter();
    // exactly what the mutation engine would persist for one edited leaf:
    await a.writeEntry("pages", "home", {
      features: { items: [{ title: "EDITED" }] },
    });
    const items = [
      { title: "Fast", desc: "speedy" },
      { title: "SEO", desc: "found" },
    ];
    const out = (await runWithRequestContext(ctx(a, false), () =>
      editable("pages::home::features.items", items),
    )) as typeof items;

    expect(out[0].title).toBe("EDITED"); // overridden
    expect(out[0].desc).toBe("speedy"); // default kept
    expect(out[1].title).toBe("SEO"); // default kept
  });

  it("passes through untouched outside a request context", async () => {
    const out = await editable("pages::home::x", "literal");
    expect(out).toBe("literal");
    expect(hasStega(out)).toBe(false);
  });
});
