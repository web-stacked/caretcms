import { describe, expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { draftFieldChanges, type DraftState } from "../../packages/core/src/runtime/draft-state";

/**
 * The change list behind the editor's Changes view: for a draft, which fields
 * the editor changed, which changed on the site underneath, and which both
 * changed. It must agree with what the editor sees and what Publish writes.
 */

const state = (baseData: Record<string, unknown> | null): DraftState =>
  ({ version: 1, baseRevision: 0, baseData, structured: true });

describe("draftFieldChanges", () => {
  const started = { title: "Old title", hero: "old.jpg", cta: "Call" };

  it("lists nothing for a draft equal to the entry it started from", () => {
    expect(draftFieldChanges(state(started), { ...started }, { ...started })).toEqual([]);
  });

  it("reports only the saved item of a list that wasn't stored yet, not the empty places before it", () => {
    // Saving `stats.1.label` on a list that only the template holds stores [null, { label }].
    const changes = draftFieldChanges(state({}), { stats: [null, { label: "reset every Monday" }] }, {});
    expect(changes.map((change) => change.field)).toEqual(["stats.1.label"]);
  });

  it("separates the editor's change, the site's change and a change on both sides", () => {
    const changes = draftFieldChanges(state(started),
      { title: "My title", hero: "old.jpg", cta: "Ring us" },
      { title: "Old title", hero: "new.jpg", cta: "Phone" });
    expect(changes).toEqual([
      { field: "cta", path: ["cta"], kind: "both", started: "Call", mine: "Ring us", site: "Phone" },
      { field: "hero", path: ["hero"], kind: "site", started: "old.jpg", mine: "new.jpg", site: "new.jpg" },
      { field: "title", path: ["title"], kind: "mine", started: "Old title", mine: "My title", site: "Old title" },
    ]);
  });

  it("leaves out a field both sides changed to the same value", () => {
    expect(draftFieldChanges(state(started), { ...started, title: "Same" }, { ...started, title: "Same" })).toEqual([]);
  });

  it("reports a field the editor added and one the site removed", () => {
    const { cta: _cta, ...withoutCta } = started;
    expect(draftFieldChanges(state(started), { ...started, note: "Mine" }, withoutCta)).toEqual([
      { field: "cta", path: ["cta"], kind: "site", started: "Call", mine: undefined, site: undefined },
      { field: "note", path: ["note"], kind: "mine", started: undefined, mine: "Mine", site: undefined },
    ]);
  });

  it("names each value inside an object, as the page's bindings do", () => {
    const nested = { hero: { headline: "Old", subtext: "Old sub" } };
    expect(draftFieldChanges(state(nested), { hero: { headline: "Mine", subtext: "My sub" } }, { hero: { headline: "Theirs", subtext: "Old sub" } })
      .map(({ field, kind, mine, site }) => ({ field, kind, mine, site }))).toEqual([
      { field: "hero.headline", kind: "both", mine: "Mine", site: "Theirs" },
      { field: "hero.subtext", kind: "mine", mine: "My sub", site: "Old sub" },
    ]);
  });

  it("names a value in an object the site doesn't have yet", () => {
    expect(draftFieldChanges(state({}), { hero: { headline: "Mine" } }, {}).map(({ field, kind, mine }) => ({ field, kind, mine })))
      .toEqual([{ field: "hero.headline", kind: "mine", mine: "Mine" }]);
  });

  it("names the item of a list only one side changed, and the whole list otherwise", () => {
    const list = { items: [{ title: "A" }, { title: "B" }] };
    expect(draftFieldChanges(state(list), { items: [{ title: "A" }, { title: "Mine" }] }, list).map(change => change.field)).toEqual(["items.1.title"]);
    expect(draftFieldChanges(state(list), { items: [{ title: "A" }] }, list).map(change => change.field)).toEqual(["items"]);
    expect(draftFieldChanges(state(list), { items: [{ title: "A" }, { title: "Mine" }] }, { items: [{ title: "Theirs" }, { title: "B" }] })
      .map(({ field, kind }) => ({ field, kind }))).toEqual([{ field: "items", kind: "both" }]);
  });

  it("ignores private keys and an entry deleted on the site", () => {
    expect(draftFieldChanges(state(started), { ...started, __body: { "0": { md: "x" } } }, { ...started, __caret_template__: { title: "t1" } })).toEqual([]);
    expect(draftFieldChanges(state(started), { ...started, title: "My title" }, null)).toEqual([]);
  });
});

async function setup() {
  const base = new InMemoryAdapter();
  await base.writeEntry("pages", "home", { title: "Old title", hero: "old.jpg" });
  const overlay = await base.makeEditorOverlay("editor-1");
  return { base, overlay, draft: new SessionOverlayAdapter(base, overlay) };
}

describe("the change list of a stored draft", () => {
  it("is empty without a draft", async () => {
    const { draft } = await setup();
    expect(await draft.draftChanges("pages", "home")).toEqual([]);
  });

  it("names the editor's field and the field a developer changed afterwards", async () => {
    const { base, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg" });
    expect((await draft.draftChanges("pages", "home")).map(({ field, kind }) => `${field}:${kind}`)).toEqual(["hero:site", "title:mine"]);
  });
});

describe("values inside an object", () => {
  async function nested() {
    const base = new InMemoryAdapter();
    await base.writeEntry("pages", "home", { hero: { headline: "Old", subtext: "Old sub" } });
    const overlay = await base.makeEditorOverlay("editor-1");
    return { base, overlay, draft: new SessionOverlayAdapter(base, overlay) };
  }

  it("takes one value back and leaves the rest of the object as the editor has it", async () => {
    const { base, overlay, draft } = await nested();
    await draft.writeEntry("pages", "home", { hero: { headline: "Mine", subtext: "My sub" } });
    expect(await draft.revertDraftField("pages", "home", "hero.headline")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Old", subtext: "My sub" } });
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Old", subtext: "My sub" } });
  });

  it("drops an object the editor created once its only value is taken back", async () => {
    const { draft, overlay } = await nested();
    await draft.writeEntry("pages", "home", { hero: { headline: "Old", subtext: "Old sub" }, seo: { title: "Mine" } });
    expect(await draft.revertDraftField("pages", "home", "seo.title")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Old", subtext: "Old sub" } });
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });

  it("publishes two people's changes to different values of one object", async () => {
    const { base, overlay, draft } = await nested();
    await draft.writeEntry("pages", "home", { hero: { headline: "Old", subtext: "My sub" } });
    await base.writeEntry("pages", "home", { hero: { headline: "Their headline", subtext: "Old sub" } });
    expect(await draft.draftConflict("pages", "home")).toBeNull();
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Their headline", subtext: "My sub" } });
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Their headline", subtext: "My sub" } });
  });

  it("settles a collision on one value and keeps the editor's other value in the same object", async () => {
    const { base, overlay, draft } = await nested();
    await draft.writeEntry("pages", "home", { hero: { headline: "Mine", subtext: "My sub" } });
    await base.writeEntry("pages", "home", { hero: { headline: "Theirs", subtext: "Old sub" } });
    expect((await draft.draftConflict("pages", "home"))?.fields).toEqual([{ field: "hero.headline", mine: "Mine", site: "Theirs" }]);
    const blocked = await publishOverlay(base, overlay);
    expect(blocked.conflicts).toMatchObject([{ reason: "stale_entry", fields: ["hero.headline"] }]);
    expect(await draft.resolveDraftConflict("pages", "home", "site")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Theirs", subtext: "My sub" } });
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Theirs", subtext: "My sub" } });
  });

  it("a save after the site moved records only what the editor changed in the object", async () => {
    const { base, draft } = await nested();
    await draft.writeEntry("pages", "home", { hero: { headline: "Mine", subtext: "Old sub" } });
    await base.writeEntry("pages", "home", { hero: { headline: "Theirs", subtext: "Site sub" } });
    // The editor saves again, sending back what they were shown plus a new value.
    const shown = (await draft.getEntry("pages", "home"))!.data as { hero: Record<string, string> };
    await draft.writeEntry("pages", "home", { hero: { ...shown.hero, image: "mine.jpg" } });
    await base.writeEntry("pages", "home", { hero: { headline: "Theirs", subtext: "Newer site sub" } });
    // The subtext merely followed the site, so the site's newer one shows and isn't a collision.
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ hero: { headline: "Mine", subtext: "Newer site sub", image: "mine.jpg" } });
    expect((await draft.draftConflict("pages", "home"))?.fields.map(field => field.field)).toEqual(["hero.headline"]);
  });
});

describe("taking one field of a draft back", () => {
  it("keeps the editor's other change and publishes only that", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "mine.jpg" });
    expect(await draft.revertDraftField("pages", "home", "title")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "mine.jpg" });
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "mine.jpg" });
  });

  it("takes the site's newer value, not the one the draft started from", async () => {
    const { base, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "mine.jpg" });
    await base.writeEntry("pages", "home", { title: "Their title", hero: "old.jpg" });
    expect(await draft.revertDraftField("pages", "home", "title")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Their title", hero: "mine.jpg" });
    expect(await draft.draftConflict("pages", "home")).toBeNull();
  });

  it("removes a field the editor added", async () => {
    const { draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "Old title", hero: "mine.jpg", note: "Mine" });
    expect(await draft.revertDraftField("pages", "home", "note")).toBe(true);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "mine.jpg" });
  });

  it("drops a draft left with nothing of its own", async () => {
    const { overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    expect(await draft.revertDraftField("pages", "home", "title")).toBe(true);
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });

  it("refuses a field the draft doesn't change, including one only the site changed", async () => {
    const { base, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await base.writeEntry("pages", "home", { title: "Old title", hero: "new.jpg" });
    expect(await draft.revertDraftField("pages", "home", "hero")).toBe(false);
    expect(await draft.revertDraftField("pages", "home", "missing")).toBe(false);
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "new.jpg" });
  });
});

describe("saving again while a field is in conflict", () => {
  it("doesn't record the site's newer values as the editor's own", async () => {
    const { base, overlay, draft } = await setup();
    await base.writeEntry("pages", "home", { title: "Old title", hero: "old.jpg", note: "Old note" });
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg", note: "Old note" });
    // A developer changes the note and the title: the title is now in conflict.
    await base.writeEntry("pages", "home", { title: "Their title", hero: "old.jpg", note: "Second note" });
    // The editor saves the title again, sending the page as they were shown it.
    const shown = (await draft.getEntry("pages", "home"))!.data;
    expect(shown.note).toBe("Second note");
    await draft.writeEntry("pages", "home", { ...shown, title: "My newer title" });
    // The developer changes the note once more: the editor must see it, and it is no conflict.
    await base.writeEntry("pages", "home", { title: "Their title", hero: "old.jpg", note: "Third note" });
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "My newer title", hero: "old.jpg", note: "Third note" });
    expect((await draft.draftConflict("pages", "home"))?.fields.map(({ field }) => field)).toEqual(["title"]);
    // Keeping their title publishes the title only.
    expect(await draft.resolveDraftConflict("pages", "home", "mine")).toBe(true);
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "My newer title", hero: "old.jpg", note: "Third note" });
  });

  it("after undoing a field in such a draft, a later change to it on the site shows and is no conflict", async () => {
    const { base, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "mine.jpg" });
    await base.writeEntry("pages", "home", { title: "Their title", hero: "their.jpg" });
    expect(await draft.revertDraftField("pages", "home", "hero")).toBe(true);
    await base.writeEntry("pages", "home", { title: "Their title", hero: "newest.jpg" });
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "newest.jpg" });
    expect((await draft.draftConflict("pages", "home"))?.fields.map(({ field }) => field)).toEqual(["title"]);
  });
});

describe("publishing some drafts and keeping the rest", () => {
  it("publishes only the listed entries", async () => {
    const { base, overlay, draft } = await setup();
    await base.writeEntry("pages", "about", { title: "About" });
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    await draft.writeEntry("pages", "about", { title: "My about" });
    const outcome = await publishOverlay(base, overlay, { entries: [{ collection: "pages", id: "about" }] });
    expect(outcome.published).toMatchObject([{ collection: "pages", id: "about" }]);
    expect((await base.getEntry("pages", "about"))?.data).toEqual({ title: "My about" });
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "old.jpg" });
    // The other draft is still there, and still the editor's.
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "old.jpg" });
    expect((await publishOverlay(base, overlay)).published).toMatchObject([{ collection: "pages", id: "home" }]);
  });

  it("publishes nothing for a list naming no draft", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    const outcome = await publishOverlay(base, overlay, { entries: [{ collection: "pages", id: "elsewhere" }] });
    expect(outcome.published).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "old.jpg" });
  });
});

describe("undoing a publish", () => {
  it("stages the entry as it was before the publish; publishing it puts the old values back", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    const { published } = await publishOverlay(base, overlay);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "My title", hero: "old.jpg" });
    expect(await draft.stageUndoPublish("pages", "home", published[0].revision, published[0].fingerprint!)).toBe("staged");
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "old.jpg" });
    expect((await publishOverlay(base, overlay)).conflicts).toEqual([]);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Old title", hero: "old.jpg" });
  });

  it("refuses when the entry changed after the publish", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    const { published } = await publishOverlay(base, overlay);
    await base.writeEntry("pages", "home", { title: "My title", hero: "new.jpg" });
    await base.bumpRevision("pages", "home");
    expect(await draft.stageUndoPublish("pages", "home", published[0].revision, published[0].fingerprint!)).toBe("changed");
    expect(await overlay.getEntry("pages", "home")).toBeNull();
  });

  it("refuses when the content file was edited directly, though the revision didn't move", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    const { published } = await publishOverlay(base, overlay);
    const revision = await base.getRevision("pages", "home");
    await base.writeEntry("pages", "home", { title: "My title", hero: "dev.jpg" });
    expect(await base.getRevision("pages", "home")).toBe(revision);
    expect(await draft.stageUndoPublish("pages", "home", published[0].revision, published[0].fingerprint!)).toBe("changed");
  });

  it("refuses when the editor already has a draft of the entry", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "home", { title: "My title", hero: "old.jpg" });
    const { published } = await publishOverlay(base, overlay);
    await draft.writeEntry("pages", "home", { title: "Next title", hero: "old.jpg" });
    expect(await draft.stageUndoPublish("pages", "home", published[0].revision, published[0].fingerprint!)).toBe("drafted");
    expect((await draft.getEntry("pages", "home"))?.data.title).toBe("Next title");
  });

  it("undoes a publish that created the entry by deleting it", async () => {
    const { base, overlay, draft } = await setup();
    await draft.writeEntry("pages", "new-page", { title: "New page" });
    const { published } = await publishOverlay(base, overlay);
    expect(await draft.stageUndoPublish("pages", "new-page", published[0].revision, published[0].fingerprint!)).toBe("staged");
    await publishOverlay(base, overlay);
    expect(await base.getEntry("pages", "new-page")).toBeNull();
  });
});

describe("undoing a publish on a Markdown site", () => {
  async function markdownSite(body: string) {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { MarkdownAdapter } = await import("../../packages/core/src/runtime/storage/markdown-adapter");
    const root = mkdtempSync(join(tmpdir(), "caret-undo-"));
    mkdirSync(join(root, "src/content/pages"), { recursive: true });
    writeFileSync(join(root, "src/content/pages/home.md"), `---\ntitle: "Old"\nhours: "Mon–Fri"\n---\n${body}`);
    const base = new MarkdownAdapter({ contentRoot: join(root, "src/content"), metaRoot: join(root, ".caretcms"), draftsRoot: join(root, ".caret/drafts"), projectRoot: root });
    const overlay = await base.makeEditorOverlay("editor-1");
    return { base, overlay, draft: new SessionOverlayAdapter(base, overlay) };
  }

  it("undoes a field publish though Markdown keeps the whole file in history", async () => {
    const { base, overlay, draft } = await markdownSite("Some body text.\n");
    const shown = (await draft.getEntry("pages", "home"))!.data;
    await draft.writeEntry("pages", "home", { ...shown, hours: "Mon–Sat" });
    const { published } = await publishOverlay(base, overlay);
    expect(await draft.stageUndoPublish("pages", "home", published[0].revision, published[0].fingerprint!)).toBe("staged");
    await publishOverlay(base, overlay);
    expect((await base.getEntry("pages", "home"))?.data).toMatchObject({ title: "Old", hours: "Mon–Fri" });
    expect(await base.readBodySource!("pages", "home")).toContain("Some body text.");
  });
});
