import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import pageContent from "./stubs/page-content";

async function setup() {
  const base = new InMemoryAdapter();
  await base.writeEntry("posts", "first", { title: "Published" });
  const overlay = await base.makeEditorOverlay("editor-1");
  return { base, overlay, draft: new SessionOverlayAdapter(base, overlay) };
}

describe("publish skips drafts that change nothing", () => {
  it("doesn't write an entry edited back to its published content", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("posts", "first", { title: "Edited" });
    await draft.writeEntry("posts", "first", { title: "Published" });
    const revision = await base.getRevision("posts", "first");
    const history = (await base.getHistory?.("posts", "first"))?.length ?? 0;

    const outcome = await publishOverlay(base, overlay);

    expect(outcome.published).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(await base.getRevision("posts", "first")).toBe(revision);
    expect((await base.getHistory?.("posts", "first"))?.length ?? 0).toBe(history);
    // The no-op draft is cleared so it stops shadowing the published entry.
    expect(await overlay.getEntry("posts", "first")).toBeNull();
  });

  it("doesn't store the page's own text for an undone edit on an entry nothing was saved for", async () => {
    const { base, overlay, draft } = await setup();
    pageContent.pages = { menu: { todays_menu: "Today's menu" } };
    try {
      await draft.writeEntry("pages", "menu", { todays_menu: "Today's menu" });
      const outcome = await publishOverlay(base, overlay);
      expect(outcome.published).toEqual([]);
      expect(await base.getEntry("pages", "menu")).toBeNull();
      expect(await overlay.getEntry("pages", "menu")).toBeNull();
    } finally {
      delete pageContent.pages;
    }
  });

  it("still publishes real changes next to a no-op draft", async () => {
    const { base, overlay, draft } = await setup();
    await base.writeEntry("posts", "second", { title: "Old" });
    await draft.writeEntry("posts", "first", { title: "Published" });
    await draft.writeEntry("posts", "second", { title: "New" });
    const outcome = await publishOverlay(base, overlay);
    expect(outcome.published.map(entry => entry.id)).toEqual(["second"]);
    expect((await base.getEntry("posts", "second"))?.data).toEqual({ title: "New" });
  });
});
