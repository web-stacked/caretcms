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
