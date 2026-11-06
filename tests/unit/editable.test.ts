import { describe, expect, it } from "vitest";
import { editable } from "../../packages/core/src/editable";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { mergeStored } from "../../packages/core/src/runtime/stega-policy";
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

  it("editor: leaves imported assets (ImageMetadata) unencoded, encodes sibling text", async () => {
    // An array item carrying an Astro image import alongside editable text.
    const items = [
      {
        title: "In-Home Healthcare",
        image: { src: "/_astro/photo.jpg?origFormat=jpg", width: 1000, height: 667, format: "jpg" },
      },
    ];
    const out = (await runWithRequestContext(ctx(new InMemoryAdapter(), true), () =>
      editable("components::services::services", items),
    )) as typeof items;

    // Asset strings must stay byte-for-byte clean — stega here corrupts the
    // image pipeline (format "jpg" → "jpg<invisible>" → UnsupportedImageFormat).
    expect(hasStega(out[0].image.src)).toBe(false);
    expect(hasStega(out[0].image.format)).toBe(false);
    expect(out[0].image.format).toBe("jpg");
    expect(out[0].image.src).toBe("/_astro/photo.jpg?origFormat=jpg");

    // Sibling editable text is still encoded as normal.
    expect(stegaClean(out[0].title)).toBe("In-Home Healthcare");
    expect(stegaDecode(out[0].title)).toBe("components::services::services.0.title");
  });

  it("passes through untouched without a CaretCMS runtime", async () => {
    const out = await editable("pages::home::x", "literal");
    expect(out).toBe("literal");
    expect(hasStega(out)).toBe(false);
  });

  it("a build (no request) applies published values, unencoded", async () => {
    const a = new InMemoryAdapter();
    await a.writeEntry("pages", "home", { hero: "Published headline", features: [null, { title: "Second, edited" }] });
    __setRuntimeServicesForTests({ adapter: a });
    try {
      expect(await editable("pages::home::hero", "Default")).toBe("Published headline");
      const features = await editable("pages::home::features", [{ title: "One" }, { title: "Two" }]);
      expect(features).toEqual([{ title: "One" }, { title: "Second, edited" }]);
      expect(hasStega(features[1].title)).toBe(false);
    } finally {
      __setRuntimeServicesForTests(null);
    }
  });

  it("an item saved before the first leaves the first untouched", async () => {
    // Saving features.1.title first stores a sparse list: [null, { title }].
    const a = new InMemoryAdapter();
    await a.writeEntry("pages", "home", JSON.parse(JSON.stringify({ features: [, { title: "Edited second" }] })));
    const out = (await runWithRequestContext(ctx(a, true), () =>
      editable("pages::home::features", [{ title: "First" }, { title: "Second" }, { title: "Third" }]),
    )) as { title: string }[];
    expect(out.map((item) => stegaClean(item.title))).toEqual(["First", "Edited second", "Third"]);
  });

  it("keeps items added beyond the default list", async () => {
    const a = new InMemoryAdapter();
    await a.writeEntry("pages", "home", { features: [null, null, { title: "Added" }] });
    const out = await runWithRequestContext(ctx(a, false), () =>
      editable("pages::home::features", [{ title: "First" }, { title: "Second" }]),
    );
    expect(out).toEqual([{ title: "First" }, { title: "Second" }, { title: "Added" }]);
  });

  it("editor: leaves values the page's code compares unmarked", async () => {
    const sections = [{ key: "bread", label: "Bread", href: "/menu#bread", slug: "sourdough-loaf" }];
    const out = (await runWithRequestContext(ctx(new InMemoryAdapter(), true), () =>
      editable("pages::menu::sections", sections),
    )) as typeof sections;
    expect(out[0].key).toBe("bread");
    expect(out[0].href).toBe("/menu#bread");
    expect(out[0].slug).toBe("sourdough-loaf");
    expect(stegaDecode(out[0].label)).toBe("pages::menu::sections.0.label");
  });
});

describe("mergeStored (content read through getCollection())", () => {
  it("treats a null item as not edited and keeps the saved list's length", () => {
    expect(mergeStored([{ t: "a" }, { t: "b" }], [null, { t: "B" }])).toEqual([{ t: "a" }, { t: "B" }]);
    // A list shortened in the Studio stays shortened.
    expect(mergeStored([{ t: "a" }, { t: "b" }, { t: "c" }], [{ t: "a" }])).toEqual([{ t: "a" }]);
  });
});
