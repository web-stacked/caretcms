import { describe, expect, it } from "vitest";
import { scanTemplate } from "../../packages/core/src/page-content-scan";
import { withoutPageDefaults, withPageContent } from "../../packages/core/src/runtime/page-content";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";

describe("scanTemplate", () => {
  it("collects literal bindings with the text and images the template states", () => {
    const content = scanTemplate(`---
const title = "Home";
---
<section class="hero">
  <h1 data-caret="pages::home::headline">Bread worth  getting up for.</h1>
  <p data-caret="pages::home::lede">Sourdough &amp; rye, <strong>every</strong> day.</p>
  <img data-caret="pages::home::hero" src="/hero.jpg" alt="">
  <p data-caret="pages::home::computed">{title}</p>
  <div data-caret-scope="site::footer"><small data-caret="note">Open daily 7–3.</small></div>
</section>`);
    expect(content).toEqual({
      pages: { home: { headline: "Bread worth getting up for.", lede: "Sourdough &amp; rye, <strong>every</strong> day.", hero: "/hero.jpg" } },
      site: { footer: { note: "Open daily 7–3." } },
    });
  });

  it("decodes entities in plain text and skips markup it can't keep", () => {
    expect(scanTemplate(`<p data-caret="a::b::c">Fish &amp; chips</p><p data-caret="a::b::d">Hi <span class="x">there</span></p>`))
      .toEqual({ a: { b: { c: "Fish & chips" } } });
  });
});

describe("withPageContent", () => {
  const content = { pages: { home: { headline: "From the page", lede: "Page lede" } } };

  it("lists and opens what pages show, with stored values winning per field", async () => {
    const adapter = new InMemoryAdapter();
    const reads = withPageContent(adapter, content);
    expect(await reads.discoverCollections()).toContain("pages");
    expect(await reads.listEntryIds("pages")).toEqual(["home"]);
    expect(await reads.getEntry("pages", "home")).toEqual({ id: "home", data: content.pages.home });
    await adapter.writeEntry("pages", "home", { headline: "Edited" });
    expect((await reads.getEntry("pages", "home"))?.data).toEqual({ headline: "Edited", lede: "Page lede" });
  });

  it("never stores anything itself", async () => {
    const adapter = new InMemoryAdapter();
    await withPageContent(adapter, content).getEntry("pages", "home");
    expect(await adapter.getEntry("pages", "home")).toBeNull();
  });
});

describe("withoutPageDefaults", () => {
  it("leaves out fields that still say what the page says", () => {
    expect(withoutPageDefaults({ headline: "From the page", lede: "New lede" }, { headline: "From the page", lede: "Page lede" }))
      .toEqual({ lede: "New lede" });
  });
});

describe("inferJsonSchema for page content", () => {
  it("reads an image path as an image and inline formatting as formatted text", async () => {
    const { inferJsonSchema } = await import("../../packages/core/src/schema-utils");
    const schema = inferJsonSchema({ hero: "/hero.jpg", lede: "Sourdough, <strong>every</strong> day.", title: "Home", note: "a < b" });
    expect(schema.properties?.hero).toMatchObject({ format: "image" });
    expect(schema.properties?.lede).toMatchObject({ format: "html" });
    expect(schema.properties?.title).not.toHaveProperty("format");
    expect(schema.properties?.note).not.toHaveProperty("format");
  });
});

describe("page content by field path", () => {
  it("fills nested fields the template binds without adding flat keys", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.writeEntry("pages", "home", { hero: { subtext: "Stored" } });
    const reads = withPageContent(adapter, { pages: { home: { "hero.headline": "From the page", "hero.subtext": "Page subtext" } } });
    expect((await reads.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "From the page", subtext: "Stored" } });
  });

  it("leaves out nested fields that still match the page", () => {
    expect(withoutPageDefaults({ hero: { headline: "From the page", subtext: "New" } }, { "hero.headline": "From the page" }))
      .toEqual({ hero: { subtext: "New" } });
  });
});

describe("editable() defaults", () => {
  it("lists every string an editable() literal states, at its path", () => {
    const content = scanTemplate([
      "---",
      "import { editable } from '@caretcms/core';",
      'const heroTitle = await editable("pages::home::hero", "Bread worth waking up for");',
      "const features = await editable('pages::home::features', [",
      "  { title: 'Slow dough', body: `Two days, \\`cold\\`.`, order: 1 },",
      "  { title: \"Local flour\", body: 'From \\'Ruby\\' farm', tags: ['a', 'b'], }, // trailing comma",
      "]);",
      "const quote = await editable(\"pages::home::quote\", someVariable);",
      "const mixed = await editable(\"pages::home::mixed\", [{ title: 'x' }, ...more]);",
      "const late = await editable<string>(\"pages::home::late\", 'Typed');",
      "---",
      "<h1>{heroTitle}</h1>",
    ].join("\n"));
    expect(content.pages.home).toEqual({
      hero: "Bread worth waking up for",
      "features.0.title": "Slow dough",
      "features.0.body": "Two days, `cold`.",
      "features.1.title": "Local flour",
      "features.1.body": "From 'Ruby' farm",
      "features.1.tags.0": "a",
      "features.1.tags.1": "b",
      late: "Typed",
    });
  });

  it("reads an editable() call without a field prefix", () => {
    const content = scanTemplate("---\nconst data = await editable('components::footer', { note: 'Since 2016', links: [{ label: 'Menu', href: '/menu' }] });\n---\n");
    expect(content.components.footer).toEqual({ note: "Since 2016", "links.0.label": "Menu", "links.0.href": "/menu" });
  });
});
