import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { rewriteCaretAttributes } from "../../packages/core/src/runtime/rewrite";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { merged } from "../../packages/core/src/runtime/page-content";
import { templateHash, templateWins, trackTemplateText } from "../../packages/core/src/runtime/template-text";
import { TEMPLATE_TEXT_KEY } from "../../packages/core/src/runtime/draft-state";
import { stripBodyOverlay } from "../../packages/core/src/runtime/utils";
import pageContent from "./stubs/page-content";

/**
 * A heading written in a template and a value saved for it are two sources
 * for the same text. The saved value shows, until a developer changes the
 * template: then their newer text shows, and the old value is dropped at the
 * next publish. Each entry records which template text its values replaced.
 */

const record = (fields: Record<string, string>) =>
  ({ [TEMPLATE_TEXT_KEY]: Object.fromEntries(Object.entries(fields).map(([field, text]) => [field, templateHash(text)])) });

afterEach(() => { for (const key of Object.keys(pageContent)) delete pageContent[key]; });

describe("templateWins", () => {
  const saved = { headline: "Saved headline", ...record({ headline: "Template headline" }) };

  it("is false while the template still says what the value replaced", () => {
    expect(templateWins(saved, "headline", "Template headline")).toBe(false);
  });

  it("is true once the template's text changed", () => {
    expect(templateWins(saved, "headline", "Developer's new headline")).toBe(true);
  });

  it("is false for a value saved before records existed", () => {
    expect(templateWins({ headline: "Saved headline" }, "headline", "Anything")).toBe(false);
  });

  it("is false for a field the template doesn't state", () => {
    expect(templateWins(saved, "headline", undefined)).toBe(false);
  });
});

describe("trackTemplateText", () => {
  const template = { headline: "Template headline", "hero.cta": "Call now" };

  it("records the template text a newly saved value replaces", () => {
    expect(trackTemplateText(null, { headline: "Saved" }, template)).toEqual({
      data: { headline: "Saved", ...record({ headline: "Template headline" }) }, dropped: [] });
  });

  it("starts a record for a value saved before records existed", () => {
    const previous = { headline: "Saved" };
    expect(trackTemplateText(previous, { headline: "Saved", other: 1 }, template).data)
      .toEqual({ headline: "Saved", other: 1, ...record({ headline: "Template headline" }) });
  });

  it("keeps the record of a value that wasn't touched", () => {
    const previous = { headline: "Saved", hero: { cta: "Ring" }, ...record({ headline: "Template headline", "hero.cta": "Call now" }) };
    expect(trackTemplateText(previous, { headline: "Saved again", hero: { cta: "Ring" } }, template).data)
      .toEqual({ headline: "Saved again", hero: { cta: "Ring" }, ...record({ headline: "Template headline", "hero.cta": "Call now" }) });
  });

  it("drops an untouched value the template has overtaken, and an object it leaves empty", () => {
    const previous = { headline: "Saved", hero: { cta: "Ring" }, ...record({ headline: "Template headline", "hero.cta": "Old button" }) };
    expect(trackTemplateText(previous, { headline: "Saved", hero: { cta: "Ring" } }, template)).toEqual({
      data: { headline: "Saved", ...record({ headline: "Template headline" }) }, dropped: ["hero.cta"] });
  });

  it("keeps a value saved again after the template changed, recorded against the new text", () => {
    const previous = { headline: "Saved", ...record({ headline: "Older template text" }) };
    expect(trackTemplateText(previous, { headline: "Editor's newest" }, template)).toEqual({
      data: { headline: "Editor's newest", ...record({ headline: "Template headline" }) }, dropped: [] });
  });

  it("writes no record for an entry no template states", () => {
    expect(trackTemplateText(null, { title: "Post", [TEMPLATE_TEXT_KEY]: { title: "x" } }, undefined).data).toEqual({ title: "Post" });
  });
});

describe("a template changed after its text was published", () => {
  const PAGE = '<h1 data-caret="pages::home::headline">Template headline</h1><p data-caret="pages::home::intro">Template intro</p>';

  async function published() {
    pageContent.pages = { home: { headline: "Template headline", intro: "Template intro" } };
    const base = new InMemoryAdapter();
    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);
    await draft.writeEntry("pages", "home", { headline: "Saved headline", intro: "Saved intro" });
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    return { base, overlay, draft };
  }

  it("publishing records the template text beside the values", async () => {
    const { base } = await published();
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ headline: "Saved headline", intro: "Saved intro",
      ...record({ headline: "Template headline", intro: "Template intro" }) });
  });

  it("the record never reaches pages, the Studio or schema checks", async () => {
    const { base } = await published();
    expect(stripBodyOverlay((await base.getEntry("pages", "home"))!.data)).toEqual({ headline: "Saved headline", intro: "Saved intro" });
    const browserWrite = await executeMutation(base, { type: "save_field", collection: "pages", id: "home", field: `${TEMPLATE_TEXT_KEY}.headline`, value: "x" });
    expect(browserWrite.ok).toBe(false);
  });

  it("shows saved values while the template is unchanged", async () => {
    const { base } = await published();
    expect(await rewriteCaretAttributes(PAGE, base)).toBe(
      '<h1 data-caret="pages::home::headline">Saved headline</h1><p data-caret="pages::home::intro">Saved intro</p>');
  });

  it("shows the developer's new text, for that binding only", async () => {
    const { base } = await published();
    pageContent.pages.home.headline = "Developer's new headline";
    const page = PAGE.replace("Template headline", "Developer's new headline");
    const kept: string[] = [];
    expect(await rewriteCaretAttributes(page, base, { onTemplateWins: (binding) => kept.push(binding) })).toBe(
      '<h1 data-caret="pages::home::headline">Developer\'s new headline</h1><p data-caret="pages::home::intro">Saved intro</p>');
    expect(kept).toEqual(["pages::home::headline"]);
  });

  it("the Studio reads the developer's text too", async () => {
    const { base } = await published();
    pageContent.pages.home.headline = "Developer's new headline";
    const entry = merged(await base.getEntry("pages", "home"), "home", pageContent.pages.home);
    expect(stripBodyOverlay(entry!.data)).toEqual({ headline: "Developer's new headline", intro: "Saved intro" });
  });

  it("a build passes its own scan of the templates", async () => {
    const { base } = await published();
    const page = PAGE.replace("Template headline", "Developer's new headline");
    const out = await rewriteCaretAttributes(page, base, { pageContent: { pages: { home: { headline: "Developer's new headline", intro: "Template intro" } } } });
    expect(out).toContain(">Developer's new headline</h1>");
    expect(out).toContain(">Saved intro</p>");
  });

  it("the next publish removes the overtaken value and keeps the rest", async () => {
    const { base, overlay, draft } = await published();
    pageContent.pages.home.headline = "Developer's new headline";
    // The editor edits the intro in place; the headline isn't touched.
    expect((await executeMutation(draft, { type: "save_field", collection: "pages", id: "home", field: "intro", value: "Edited intro" })).ok).toBe(true);
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ intro: "Edited intro", ...record({ intro: "Template intro" }) });
  });

  it("an editor's newer edit to that text beats the template again", async () => {
    const { base, overlay, draft } = await published();
    pageContent.pages.home.headline = "Developer's new headline";
    const page = PAGE.replace("Template headline", "Developer's new headline");
    await draft.writeEntry("pages", "home", { headline: "Editor's newest headline", intro: "Saved intro" });
    // The editor sees their draft over the template...
    expect(await rewriteCaretAttributes(page, draft)).toContain(">Editor's newest headline</h1>");
    // ...and publishing records it against the template as it is now.
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ headline: "Editor's newest headline", intro: "Saved intro",
      ...record({ headline: "Developer's new headline", intro: "Template intro" }) });
    expect(await rewriteCaretAttributes(page, base)).toContain(">Editor's newest headline</h1>");
  });

  it("a draft of another field still shows the developer's text", async () => {
    const { base, draft } = await published();
    pageContent.pages.home.headline = "Developer's new headline";
    const page = PAGE.replace("Template headline", "Developer's new headline");
    await draft.writeEntry("pages", "home", { headline: "Saved headline", intro: "Draft intro" });
    const out = await rewriteCaretAttributes(page, draft);
    expect(out).toContain(">Developer's new headline</h1>");
    expect(out).toContain(">Draft intro</p>");
    expect((await base.getEntry("pages", "home"))?.data.headline).toBe("Saved headline");
  });

  it("a save straight to published content keeps the record current", async () => {
    pageContent.pages = { home: { headline: "Template headline" } };
    const base = new InMemoryAdapter();
    expect((await executeMutation(base, { type: "save_field", collection: "pages", id: "home", field: "headline", value: "Saved" })).ok).toBe(true);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ headline: "Saved", ...record({ headline: "Template headline" }) });
  });
});
