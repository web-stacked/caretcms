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
