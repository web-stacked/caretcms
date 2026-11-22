import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { rebaseDraft, type DraftState } from "../../packages/core/src/runtime/draft-state";

/**
 * A draft is a full copy of the entry. When the published entry changes after
 * the draft was started (a developer commits to the same file), the draft must
 * not put its old copy over the newer content: only the fields the editor
 * changed belong to the draft.
 */

const state = (baseData: Record<string, unknown> | null): DraftState =>
  ({ version: 1, baseRevision: 0, baseData, structured: true });

describe("rebaseDraft", () => {
  const started = { title: "Old title", hero: "old.jpg", cta: "Call" };

  it("returns the draft untouched while the published entry hasn't moved", () => {
    const draft = { ...started, title: "My title" };
    expect(rebaseDraft(state(started), draft, { ...started })).toEqual({ data: draft, conflicts: [], conflictPaths: [], removed: false });
  });

  it("keeps the editor's field and takes the others from the published entry", () => {
    const out = rebaseDraft(state(started), { ...started, title: "My title" }, { ...started, hero: "new.jpg" });
    expect(out).toEqual({ data: { title: "My title", hero: "new.jpg", cta: "Call" }, conflicts: [], conflictPaths: [], removed: false });
  });

  it("shows a field added to the published entry after the draft started", () => {
    const out = rebaseDraft(state(started), { ...started, title: "My title" }, { ...started, announcement: "New" });
    expect(out.data).toEqual({ title: "My title", hero: "old.jpg", cta: "Call", announcement: "New" });
    expect(out.conflicts).toEqual([]);
  });

  it("drops a field removed from the published entry that the editor didn't touch", () => {
    const { cta: _cta, ...withoutCta } = started;
    const out = rebaseDraft(state(started), { ...started, title: "My title" }, withoutCta);
    expect(out.data).toEqual({ title: "My title", hero: "old.jpg" });
    expect(out.conflicts).toEqual([]);
  });

  it("keeps a field the editor removed", () => {
    const { cta: _cta, ...withoutCta } = started;
    const out = rebaseDraft(state(started), withoutCta, { ...started, hero: "new.jpg" });
    expect(out.data).toEqual({ title: "Old title", hero: "new.jpg" });
    expect(out.conflicts).toEqual([]);
  });

  it("is no conflict when both sides made the same change", () => {
    const out = rebaseDraft(state(started), { ...started, title: "Same" }, { ...started, title: "Same", hero: "new.jpg" });
    expect(out).toEqual({ data: { title: "Same", hero: "new.jpg", cta: "Call" }, conflicts: [], conflictPaths: [], removed: false });
  });

  it("reports a field changed on both sides and keeps the editor's value", () => {
    const out = rebaseDraft(state(started), { ...started, title: "Mine" }, { ...started, title: "Theirs", hero: "new.jpg" });
    expect(out.data).toEqual({ title: "Mine", hero: "new.jpg", cta: "Call" });
    expect(out.conflicts).toEqual(["title"]);
  });

  it("reports a field the editor changed and the published entry removed", () => {
    const { cta: _cta, ...withoutCta } = started;
    expect(rebaseDraft(state(started), { ...started, cta: "Ring us" }, withoutCta).conflicts).toEqual(["cta"]);
  });

  it("compares nested values by content, not key order", () => {
    const base = { seo: { title: "A", description: "B" }, title: "Old" };
    const out = rebaseDraft(state(base), { seo: { description: "B", title: "A" }, title: "Mine" }, { ...base, title: "Old", extra: 1 });
    expect(out.conflicts).toEqual([]);
    expect(out.data).toEqual({ seo: { title: "A", description: "B" }, title: "Mine", extra: 1 });
  });

  it("passes body drafts through", () => {
    const body = { "1": { md: "x" } };
    const out = rebaseDraft(state(started), { ...started, __body: body }, { ...started, hero: "new.jpg" });
    expect(out.data).toEqual({ title: "Old title", hero: "new.jpg", cta: "Call", __body: body });
  });

  describe("inside an object", () => {
    const nested = { hero: { headline: "Old", subtext: "Old sub", image: "a.jpg" }, title: "T" };

    it("merges changes to different keys of the same object", () => {
      const out = rebaseDraft(state(nested), { ...nested, hero: { ...nested.hero, subtext: "My sub" } },
        { ...nested, hero: { ...nested.hero, headline: "Their headline" } });
      expect(out.conflicts).toEqual([]);
      expect(out.data).toEqual({ hero: { headline: "Their headline", subtext: "My sub", image: "a.jpg" }, title: "T" });
    });

    it("names the key both sides changed and keeps the editor's value", () => {
      const out = rebaseDraft(state(nested), { ...nested, hero: { ...nested.hero, headline: "Mine", subtext: "My sub" } },
        { ...nested, hero: { ...nested.hero, headline: "Theirs", image: "b.jpg" } });
      expect(out.conflicts).toEqual(["hero.headline"]);
      expect(out.conflictPaths).toEqual([["hero", "headline"]]);
      expect(out.data).toEqual({ hero: { headline: "Mine", subtext: "My sub", image: "b.jpg" }, title: "T" });
    });

    it("merges an object each side created with different keys", () => {
      const out = rebaseDraft(state({ title: "T" }), { title: "T", hero: { subtext: "Mine" } }, { title: "T", hero: { headline: "Theirs" } });
      expect(out.conflicts).toEqual([]);
      expect(out.data).toEqual({ title: "T", hero: { headline: "Theirs", subtext: "Mine" } });
    });

    it("keeps a key the editor removed and a key the site removed", () => {
      const out = rebaseDraft(state(nested), { ...nested, hero: { headline: "Old", image: "a.jpg" } },
        { ...nested, hero: { headline: "Old", subtext: "Old sub" } });
      expect(out.conflicts).toEqual([]);
      expect(out.data).toEqual({ hero: { headline: "Old" }, title: "T" });
    });

    it("treats a list both sides changed as one value", () => {
      const list = { items: [{ title: "A", featured: false }, { title: "B", featured: false }] };
      const mine = { items: [{ title: "A", featured: true }, { title: "B", featured: false }] };
      // The site swapped the two items: merging by position would feature the wrong one.
      const site = { items: [{ title: "B", featured: false }, { title: "A", featured: false }] };
      const out = rebaseDraft(state(list), mine, site);
      expect(out.conflicts).toEqual(["items"]);
      expect(out.data).toEqual(mine);
    });

    it("follows the site for a list only the site changed", () => {
      const list = { items: [{ title: "A" }], title: "T" };
      const out = rebaseDraft(state(list), { ...list, title: "Mine" }, { ...list, items: [{ title: "A" }, { title: "B" }] });
      expect(out.conflicts).toEqual([]);
      expect(out.data).toEqual({ items: [{ title: "A" }, { title: "B" }], title: "Mine" });
    });
  });

  it("marks a draft whose published entry was deleted", () => {
    const draft = { ...started, title: "Mine" };
    expect(rebaseDraft(state(started), draft, null)).toEqual({ data: draft, conflicts: ["title"], conflictPaths: [["title"]], removed: true });
  });

  it("compares a new entry's draft with an entry that appeared under the same id", () => {
    const out = rebaseDraft(state(null), { title: "Mine", hero: "a.jpg" }, { title: "Theirs", hero: "a.jpg", cta: "Call" });
    expect(out.conflicts).toEqual(["title"]);
    expect(out.data).toEqual({ title: "Mine", hero: "a.jpg", cta: "Call" });
  });
});

async function setup() {
  const base = new InMemoryAdapter();
  await base.writeEntry("pages", "home", { title: "Old title", hero: "old.jpg" });
  const overlay = await base.makeEditorOverlay("editor-1");
  return { base, overlay, draft: new SessionOverlayAdapter(base, overlay) };
}

describe("a draft whose published entry changed", () => {
  it("shows the newer published fields beside the editor's own edit", async () => {
    const { base, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    // A developer commits a new hero image and a new field to the same entry.
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg", announcement: "Open in winter" });

    const expected = { title: "My title", hero: "new.jpg", announcement: "Open in winter" };
    expect((await draft.getEntry("pages", "home"))?.data).toEqual(expected);
    expect((await draft.getEntrySnapshot("pages", "home")).entry?.data).toEqual(expected);
    expect((await draft.getEntrySnapshots("pages", ["home"]))[0].entry?.data).toEqual(expected);
    expect((await draft.listEntries("pages"))[0].data).toEqual(expected);
  });

  it("publishes the editor's field without undoing the newer ones", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg" });

    const outcome = await publishOverlay(base, overlay);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.published.map(({ collection, id }) => ({ collection, id }))).toEqual([{ collection: "pages", id: "home" }]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "new.jpg" });
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });

  it("refuses to publish a field changed on both sides, and names it", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Their title", hero: "new.jpg" });

    const outcome = await publishOverlay(base, overlay);

    expect(outcome.published).toEqual([]);
    expect(outcome.conflicts).toEqual([{ collection: "pages", id: "home", reason: "stale_entry", fields: ["title"] }]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Their title", hero: "new.jpg" });
    // The editor still sees their own value for the field in conflict.
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "new.jpg" });
  });

  it("clears a draft that the published entry caught up with", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "Same title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Same title", hero: "new.jpg" });

    const outcome = await publishOverlay(base, overlay);

    expect(outcome.published).toEqual([]);
    expect(outcome.conflicts).toEqual([]);
    expect(await overlay.getEntry("pages", "home")).toBeNull();
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Same title", hero: "new.jpg" });
  });

  it("refuses to publish a deletion of an entry that changed", async () => {
    const { base, overlay, draft } = await setup();
    await draft.deleteEntry("pages", "home");
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg" });

    const outcome = await publishOverlay(base, overlay);

    expect(outcome.conflicts).toEqual([{ collection: "pages", id: "home", reason: "stale_entry" }]);
    expect(await base.getEntry("pages", "home")).not.toBeNull();
  });

  it("refuses to publish a draft whose entry was deleted", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.deleteEntry("pages", "home");

    const outcome = await publishOverlay(base, overlay);

    expect(outcome.published).toEqual([]);
    expect(outcome.conflicts).toMatchObject([{ collection: "pages", id: "home", reason: "stale_entry" }]);
    expect(await base.getEntry("pages", "home")).toBeNull();
  });

  it("restarts the draft from the current entry on the editor's next save", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg" });
    // The editor's browser still holds the old hero and saves the whole entry again.
    await draft.writeEntry("pages", "home", { title: "My second title", hero: "old.jpg" });

    expect((await draft.getOwnEntry("pages", "home"))?.data).toEqual({ title: "My second title", hero: "new.jpg" });
    // A second published change to the field the editor never touched is still no conflict.
    await base.writeEntry("pages", "home", { title: "Old title", hero: "newest.jpg" });
    const outcome = await publishOverlay(base, overlay);
    expect(outcome.conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "My second title", hero: "newest.jpg" });
  });

  it("keeps the first baseline while a field is in conflict", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Their title", hero: "old.jpg" });
    await draft.writeEntry("pages", "home", { title: "My second title", hero: "old.jpg" });

    expect((await publishOverlay(base, overlay)).conflicts).toEqual([{ collection: "pages", id: "home", reason: "stale_entry", fields: ["title"] }]);
  });
});

describe("settling a draft in conflict", () => {
  async function conflicted() {
    const world = await setup();
    await world.draft.writeEntry("pages", "home", { title: "My title", hero: "mine.jpg" });
    await world.base.writeEntry("pages", "home", { title: "Their title", hero: "old.jpg", cta: "Call" });
    return world;
  }

  it("reports each colliding field with both values", async () => {
    const { draft } = await conflicted();
    expect(await draft.draftConflict("pages", "home")).toEqual({ collection: "pages", id: "home", removed: false, body: [],
      fields: [{ field: "title", mine: "My title", site: "Their title" }] });
  });

  it("reports nothing for a draft that only needs carrying over", async () => {
    const { base, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg" });
    expect(await draft.draftConflict("pages", "home")).toBeNull();
    expect(await draft.resolveDraftConflict("pages", "home", "mine")).toBe(false);
  });

  it("keeps the editor's values and lets Publish put them on top", async () => {
    const { base, overlay, draft } = await conflicted();
    expect(await draft.resolveDraftConflict("pages", "home", "mine")).toBe(true);
    expect(await draft.draftConflict("pages", "home")).toBeNull();
    const outcome = await publishOverlay(base, overlay);
    expect(outcome.conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "mine.jpg", cta: "Call" });
  });

  it("takes the site's value for the colliding field and keeps the editor's other change", async () => {
    const { base, overlay, draft } = await conflicted();
    expect(await draft.resolveDraftConflict("pages", "home", "site")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Their title", hero: "mine.jpg", cta: "Call" });
    const outcome = await publishOverlay(base, overlay);
    expect(outcome.conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Their title", hero: "mine.jpg", cta: "Call" });
  });

  it("drops a draft left with nothing of its own", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Their title", hero: "old.jpg" });
    expect(await draft.resolveDraftConflict("pages", "home", "site")).toBe(true);
    expect(await overlay.getEntry("pages", "home")).toBeNull();
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Their title", hero: "old.jpg" });
  });

  it("republishes a deleted entry as new when the editor keeps their draft", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.deleteEntry("pages", "home");
    expect((await draft.draftConflict("pages", "home"))?.removed).toBe(true);
    expect(await draft.resolveDraftConflict("pages", "home", "mine")).toBe(true);
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "old.jpg" });
  });

  it("drops the draft of a deleted entry when the editor follows the site", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.deleteEntry("pages", "home");
    expect(await draft.resolveDraftConflict("pages", "home", "site")).toBe(true);
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });
});
