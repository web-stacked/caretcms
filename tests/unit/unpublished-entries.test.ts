import { describe, expect, it } from "vitest";
import { GET } from "../../packages/core/src/runtime/routes/entries";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { allUnpublishedEntries, countPendingDrafts, unpublishedEntries } from "../../packages/core/src/runtime/unpublished";
import pageContent from "./stubs/page-content";

async function drafts() {
  const base = new InMemoryAdapter();
  await base.writeEntry("posts", "same", { title: "Same" });
  await base.writeEntry("posts", "edited", { title: "Before" });
  await base.writeEntry("posts", "removed", { title: "Removed" });
  await base.writeEntry("posts", "untouched", { title: "Untouched" });
  const adapter = new SessionOverlayAdapter(base, await base.makeEditorOverlay("editor-1"));
  await adapter.writeEntry("posts", "same", { title: "Same" });
  await adapter.writeEntry("posts", "edited", { title: "After" });
  await adapter.writeEntry("posts", "created", { title: "Created" });
  await adapter.deleteEntry("posts", "removed");
  await adapter.writeEntry("pages", "home", { headline: "Draft headline" });
  return { base, adapter };
}

function inDrafts<T>(base: InMemoryAdapter, adapter: SessionOverlayAdapter, run: () => Promise<T>, demoMode = false) {
  return runWithRequestContext({ adapter, publishedAdapter: base, uploadHandler: {} as never, sessionId: null, demoMode, overlayActive: true, identity: { id: "editor-1" } }, run);
}

describe("unpublished entries", () => {
  it("lists only drafts that differ from what visitors see", async () => {
    const { base, adapter } = await drafts();
    const posts = await inDrafts(base, adapter, () => unpublishedEntries("posts"));
    expect(posts.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { collection: "posts", id: "created", deleted: false },
      { collection: "posts", id: "edited", deleted: false },
      { collection: "posts", id: "removed", deleted: true },
    ]);
    const all = await inDrafts(base, adapter, () => allUnpublishedEntries());
    expect(all.map(entry => `${entry.collection}/${entry.id}`)).toContain("pages/home");
  });

  it("doesn't list an undone edit on an entry the page shows without saved content", async () => {
    const base = new InMemoryAdapter();
    const adapter = new SessionOverlayAdapter(base, await base.makeEditorOverlay("editor-1"));
    pageContent.pages = { menu: { todays_menu: "Today's menu", note: "Prices include tax." } };
    try {
      // Edited, then undone: the draft now stores exactly the page's text.
      await adapter.writeEntry("pages", "menu", { todays_menu: "Today's menu" });
      expect(await inDrafts(base, adapter, () => unpublishedEntries("pages"))).toEqual([]);
      expect(await countPendingDrafts(base, await base.makeEditorOverlay("editor-1"))).toBe(0);
      await adapter.writeEntry("pages", "menu", { todays_menu: "Tomorrow's menu" });
      expect(await inDrafts(base, adapter, () => unpublishedEntries("pages"))).toEqual([{ collection: "pages", id: "menu", deleted: false }]);
      expect(await countPendingDrafts(base, await base.makeEditorOverlay("editor-1"))).toBe(1);
    } finally {
      delete pageContent.pages;
    }
  });

  it("counts drafts that change what visitors see, not ones edited back", async () => {
    const { base } = await drafts();
    // created, edited, removed, pages/home; "same" matches what is published.
    expect(await countPendingDrafts(base, await base.makeEditorOverlay("editor-1"))).toBe(4);
  });

  it("is empty outside draft modes and in demo sandboxes", async () => {
    const { base, adapter } = await drafts();
    expect(await unpublishedEntries("posts")).toEqual([]);
    expect(await inDrafts(base, adapter, () => unpublishedEntries("posts"), true)).toEqual([]);
  });

  it("marks listed entries that have unpublished changes", async () => {
    const { base, adapter } = await drafts();
    const response = await inDrafts(base, adapter, () =>
      GET({ request: new Request("http://localhost/api/cms/entries?collection=posts"), cookies: { get: () => undefined } } as never));
    const body = await response.json() as { entries: Array<{ id: string; draft?: boolean }> };
    expect(Object.fromEntries(body.entries.map(entry => [entry.id, entry.draft === true]))).toEqual({
      created: true, edited: true, same: false, untouched: false,
    });
  });
});
