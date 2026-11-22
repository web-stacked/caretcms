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

  it("separates the editor's change, the site's change and a change on both sides", () => {
    const changes = draftFieldChanges(state(started),
      { title: "My title", hero: "old.jpg", cta: "Ring us" },
      { title: "Old title", hero: "new.jpg", cta: "Phone" });
    expect(changes).toEqual([
      { field: "cta", kind: "both", started: "Call", mine: "Ring us", site: "Phone" },
      { field: "hero", kind: "site", started: "old.jpg", mine: "new.jpg", site: "new.jpg" },
      { field: "title", kind: "mine", started: "Old title", mine: "My title", site: "Old title" },
    ]);
  });

  it("leaves out a field both sides changed to the same value", () => {
    expect(draftFieldChanges(state(started), { ...started, title: "Same" }, { ...started, title: "Same" })).toEqual([]);
  });

  it("reports a field the editor added and one the site removed", () => {
    const { cta: _cta, ...withoutCta } = started;
    expect(draftFieldChanges(state(started), { ...started, note: "Mine" }, withoutCta)).toEqual([
      { field: "cta", kind: "site", started: "Call", mine: undefined, site: undefined },
      { field: "note", kind: "mine", started: undefined, mine: "Mine", site: undefined },
    ]);
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
