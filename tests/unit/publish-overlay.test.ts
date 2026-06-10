import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay, discardOverlay } from "../../packages/core/src/runtime/publish";

/** A base seeded with one entry, plus a per-editor overlay and the merged
 *  draft view an editor edits through. */
async function setup() {
  const base = new InMemoryAdapter();
  await base.writeEntry("pages", "home", { title: "Published" });
  const overlay = await base.makeEditorOverlay("editor-1");
  const draft = new SessionOverlayAdapter(base, overlay);
  return { base, overlay, draft };
}

describe("publishOverlay", () => {
  it("flushes a draft edit into the base, bumps revision, and clears the overlay", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "Edited" });

    const baseRevBefore = await base.getRevision("pages", "home");
    const result = await publishOverlay(base, overlay, { collection: "pages", id: "home" });

    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Edited" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ collection: "pages", id: "home", deleted: false });
    // revision advanced, and the returned value matches the base (client reconcile)
    expect(result[0].revision).toBeGreaterThan(baseRevBefore);
    expect(result[0].revision).toBe(await base.getRevision("pages", "home"));
    // overlay no longer shadows the base
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });

  it("does not 409 on the next edit after publish (overlay cleared, revisions reconcilable)", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "v1" });
    await publishOverlay(base, overlay, { collection: "pages", id: "home" });

    // editing again starts a fresh draft off the published base
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "v1" });
    await draft.writeEntry("pages", "home", { title: "v2" });
    const second = await publishOverlay(base, overlay, { collection: "pages", id: "home" });
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "v2" });
    expect(second[0].revision).toBe(await base.getRevision("pages", "home"));
  });

  it("publishes a draft deletion as a real base delete", async () => {
    const { base, overlay, draft } = await setup();
    await draft.deleteEntry("pages", "home"); // writes a tombstone into the overlay

    const result = await publishOverlay(base, overlay, { collection: "pages", id: "home" });
    expect(result[0]).toMatchObject({ deleted: true });
    expect(await base.getEntry("pages", "home")).toBeNull();
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });

  it("scopes publishing to a single entry, leaving other drafts pending", async () => {
    const { base, overlay, draft } = await setup();
    await base.writeEntry("pages", "about", { title: "About published" });
    await draft.writeEntry("pages", "home", { title: "home draft" });
    await draft.writeEntry("pages", "about", { title: "about draft" });

    const result = await publishOverlay(base, overlay, { collection: "pages", id: "home" });
    expect(result).toHaveLength(1);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "home draft" });
    // the unscoped draft is still pending in the overlay
    expect((await base.getEntry("pages", "about"))?.data).toEqual({ title: "About published" });
    expect((await overlay.getEntry("pages", "about"))?.data).toEqual({ title: "about draft" });
  });

  it("publishes everything when scope is empty", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "h" });
    await draft.writeEntry("posts", "first", { title: "p" });

    const result = await publishOverlay(base, overlay);
    const pairs = result.map((r) => `${r.collection}/${r.id}`).sort();
    expect(pairs).toEqual(["pages/home", "posts/first"]);
    expect((await base.getEntry("posts", "first"))?.data).toEqual({ title: "p" });
  });
});

describe("discardOverlay", () => {
  it("clears drafts without touching the base", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "draft" });

    const cleared = await discardOverlay(overlay, { collection: "pages", id: "home" });
    expect(cleared).toBe(1);
    expect(await overlay.getEntry("pages", "home")).toBeNull();
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Published" });
  });
});
