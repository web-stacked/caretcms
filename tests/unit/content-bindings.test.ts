import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAstroCollectionSchemas } from "../../packages/core/src/index";
import { bindCollectionEntries, bindCollectionEntry, bindDataFile, loadDataFileEntries } from "../../packages/core/src/runtime/content-bindings";
import { runWithRequestContext, type CaretRequestContext } from "../../packages/core/src/runtime/request-context";
import { registerCollectionSchema } from "../../packages/core/src/runtime/schema-registry";
import { hasStega, stegaClean, stegaCombine, stegaDecode } from "../../packages/core/src/runtime/stega";
import { cleanNonContentStega, promoteAttributeStega } from "../../packages/core/src/runtime/stega-attributes";
import { contentHash, encodeBound, encodeContent, isEncodableText, mergeStored, payloadKey } from "../../packages/core/src/runtime/stega-policy";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import type { StorageAdapter, UploadHandler } from "../../packages/core/src/types";

function context(adapter: StorageAdapter, editor: boolean, extra: Partial<CaretRequestContext> = {}): CaretRequestContext {
  return { adapter, uploadHandler: {} as UploadHandler, sessionId: null, demoMode: false, editor, ...extra };
}

const keyOf = (value: unknown) => (stegaDecode<{ k: string }>(value as string) ?? undefined)?.k;

describe("stega policy", () => {
  it("encodes display text and leaves machine values alone", () => {
    expect(isEncodableText("Good coffee, no rush", "title")).toBe(true);
    expect(isEncodableText("Running app", "category")).toBe(true);
    expect(isEncodableText("/assets/hero.webp", "image")).toBe(true);
    for (const [value, field] of [
      ["pace", "slug"], ["target", "icon"], ["/about", "href"], ["https://x.com", "url"], ["mailto:a@b.c", "email"],
      ["plant-based", "diet"], ["2026", "year"], ["#ff0000", "accent"], ["", "title"], ["  ", "title"],
    ]) expect(isEncodableText(value, field), `${field}=${value}`).toBe(false);
    expect(isEncodableText("espresso", "category", { type: "string", enum: ["espresso", "brew"] })).toBe(false);
    expect(isEncodableText("2026-01-01", "updated", { type: "string", format: "date" })).toBe(false);
    expect(isEncodableText(stegaCombine("x y", "k"), "title")).toBe(false);
  });

  it("walks nested data with the schema and skips private keys and image metadata", () => {
    const schema = {
      type: "object",
      properties: {
        category: { type: "string", enum: ["espresso"] },
        tags: { type: "array", items: { type: "string", enum: ["vegan"] } },
        hours: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } },
      },
    };
    const image = { src: "/_astro/a.webp", width: 10, height: 10, format: "webp" };
    const out = encodeContent({
      name: "Cappuccino", category: "espresso", tags: ["vegan"], hours: [{ label: "Weekdays" }],
      cover: image, __body: { x: "Body" }, price: 5, when: new Date(0),
    }, "menu::cappuccino", "", schema) as Record<string, any>;
    expect(keyOf(out.name)).toBe("menu::cappuccino::name");
    expect(keyOf(out.hours[0].label)).toBe("menu::cappuccino::hours.0.label");
    expect(out.category).toBe("espresso");
    expect(out.tags).toEqual(["vegan"]);
    expect(out.cover).toBe(image);
    expect(out.__body).toEqual({ x: "Body" });
    expect(out.price).toBe(5);
    expect(out.when).toBeInstanceOf(Date);
  });

  it("overlays stored values only where types agree", () => {
    const when = new Date(0);
    expect(mergeStored({ title: "A", when, order: 1, tags: ["x"], extra: true }, { title: "B", when: "1970-01-01", order: "2", tags: ["y", "z"], __body: {} }))
      .toEqual({ title: "B", when, order: 1, tags: ["y", "z"], extra: true });
  });

  it("binds a hashed payload only to the text it was made for", () => {
    const value = encodeBound("I shape the product", "site::site::about.statement");
    const payload = stegaDecode(value);
    expect(payloadKey(payload, "I  shape the\nproduct ")).toBe("site::site::about.statement");
    expect(payloadKey(payload, "product")).toBeUndefined();
    expect(payloadKey("pages::home::title", "anything")).toBe("pages::home::title");
    expect(contentHash(" a  b ")).toBe(contentHash("a b"));
  });
});

describe("bindCollectionEntries", () => {
  async function setup() {
    const adapter = new InMemoryAdapter();
    await adapter.writeEntry("menu", "cappuccino", { name: "Cappuccino", category: "espresso", description: "Draft text" });
    registerCollectionSchema("menu", { type: "object", properties: { category: { type: "string", enum: ["espresso"] } } }, null);
    const entries = [
      { id: "cappuccino", collection: "menu", data: { name: "Cappuccino", category: "espresso", description: "Source text", order: 30 } },
      { id: "unknown", collection: "menu", data: { name: "Not stored" } },
    ];
    return { adapter, entries };
  }

  it("overlays drafts and encodes display text for editors", async () => {
    const { adapter, entries } = await setup();
    const [bound, unknown] = await runWithRequestContext(context(adapter, true), () => bindCollectionEntries(entries));
    expect(stegaClean(bound.data.description as string)).toBe("Draft text");
    expect(keyOf(bound.data.name)).toBe("menu::cappuccino::name");
    expect(bound.data.category).toBe("espresso");
    expect(bound.data.order).toBe(30);
    // Entries the store cannot resolve are left as they are: no key would save anywhere.
    expect(unknown).toBe(entries[1]);
    expect(entries[0].data.description).toBe("Source text");
  });

  it("returns entries untouched for visitors and outside a request", async () => {
    const { adapter, entries } = await setup();
    expect(await runWithRequestContext(context(adapter, false), () => bindCollectionEntries(entries))).toBe(entries);
    expect(await bindCollectionEntries(entries)).toBe(entries);
    expect(await runWithRequestContext(context(adapter, true), () => bindCollectionEntry(undefined))).toBeUndefined();
  });
});

describe("bindDataFile", () => {
  const SITE = { name: "Elias", nav: [{ label: "Home", href: "/" }], year: "2026", ring: ["/a.webp"] };
  const stored = new Map([["site", new Map([["site", { ...SITE, name: "Elias Vent" }]])]]);

  it("reads values with drafts and keys during an editor request", async () => {
    const site = bindDataFile(structuredClone(SITE), "site");
    const adapter = new InMemoryAdapter();
    await runWithRequestContext(context(adapter, true, { dataFiles: stored }), async () => {
      expect(stegaClean(site.name)).toBe("Elias Vent");
      expect(keyOf(site.name)).toBe("site::site::name");
      const labels = site.nav.map((item) => item.label);
      expect(keyOf(labels[0])).toBe("site::site::nav.0.label");
      expect(site.nav[0].href).toBe("/");
      expect(site.year).toBe("2026");
      expect(site.nav.length).toBe(1);
      expect(keyOf(site.ring[0])).toBe("site::site::ring.0");
      expect(JSON.parse(stegaClean(JSON.stringify(site))).name).toBe("Elias Vent");
    });
  });

  it("returns the original values for visitors and when the entry is not stored", async () => {
    const site = bindDataFile(structuredClone(SITE), "site");
    const adapter = new InMemoryAdapter();
    expect(site.name).toBe("Elias");
    await runWithRequestContext(context(adapter, false, { dataFiles: stored }), async () => {
      expect(site.name).toBe("Elias");
    });
    await runWithRequestContext(context(adapter, true, { dataFiles: new Map() }), async () => {
      expect(site.name).toBe("Elias");
      expect(hasStega(site.nav[0].label)).toBe(false);
    });
  });

  it("maps array-form files by entry id and never encodes the id", async () => {
    const pages = bindDataFile([{ id: "faq", title: "Questions" }], "pages");
    const adapter = new InMemoryAdapter();
    await runWithRequestContext(context(adapter, true, { dataFiles: new Map([["pages", new Map([["faq", { title: "Ask us" }]])]]) }), async () => {
      expect(pages[0].id).toBe("faq");
      expect(stegaClean(pages[0].title)).toBe("Ask us");
      expect(keyOf(pages[0].title)).toBe("pages::faq::title");
    });
  });

  it("loads stored entries of data-file collections only", async () => {
    const root = await mkdtemp(join(tmpdir(), "caret-bind-"));
    try {
      await mkdir(join(root, "content", "blog"), { recursive: true });
      await writeFile(join(root, "content", "blog", "a.md"), "---\ntitle: A\n---\n");
      await writeFile(join(root, "content", "site.json"), JSON.stringify({ name: "Elias" }));
      const adapter = new MarkdownAdapter({ contentRoot: join(root, "content"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") });
      const files = await loadDataFileEntries(adapter);
      expect([...files.keys()]).toEqual(["site"]);
      expect(files.get("site")?.get("site")).toEqual({ name: "Elias" });
      expect((await loadDataFileEntries(new InMemoryAdapter())).size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("editor HTML cleanup", () => {
  it("binds a hashed image src only when the URL is unchanged", () => {
    const src = encodeBound("/assets/a.webp", "site::site::cover");
    expect(promoteAttributeStega(`<img src="${src}">`)).toBe('<img src="/assets/a.webp" data-caret="site::site::cover">');
    const prefixed = `/base${src}`;
    expect(promoteAttributeStega(`<img src="${prefixed}">`)).toBe('<img src="/base/assets/a.webp">');
  });

  it("removes stega from the head, scripts, and styles but keeps body text", () => {
    const title = encodeBound("Elias", "site::site::name");
    const html = `<html><head><title>${title}</title><script type="application/ld+json">{"name":"${title}"}</script></head><body><h1>${title}</h1><script>var n="${title}"</script></body></html>`;
    const out = cleanNonContentStega(html);
    expect(out).toContain("<title>Elias</title>");
    expect(out).toContain('{"name":"Elias"}');
    expect(out).toContain('var n="Elias"');
    expect(out).toContain(`<h1>${title}</h1>`);
  });
});

describe("readAstroCollectionSchemas", () => {
  it("reads Astro's generated schemas without the $schema field and skips untyped collections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caret-astro-schemas-"));
    try {
      await writeFile(join(dir, "menu.schema.json"), JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
        properties: { name: { type: "string" }, $schema: { type: "string" } }, required: ["name"],
      }));
      await writeFile(join(dir, "site.schema.json"), JSON.stringify({ $schema: "x" }));
      await writeFile(join(dir, "broken.schema.json"), "{");
      await writeFile(join(dir, "Not Valid.schema.json"), JSON.stringify({ type: "object", properties: { a: {} } }));
      expect(readAstroCollectionSchemas(dir)).toEqual({ menu: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
      expect(readAstroCollectionSchemas(join(dir, "missing"))).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
