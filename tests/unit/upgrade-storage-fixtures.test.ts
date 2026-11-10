import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { stripBodyOverlay } from "../../packages/core/src/runtime/utils";

const frozen = fileURLToPath(new URL("../fixtures/upgrade/pre-hardening-store/", import.meta.url));
let root: string;
function filesystem() {
  return new FilesystemAdapter({ dataRoot: join(root, "data"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") });
}
function markdown() {
  return new MarkdownAdapter({ contentRoot: join(root, "content"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") });
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "caret-upgrade-"));
  await cp(frozen, root, { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("frozen pre-hardening stores", () => {
  it.each(["before-write", "after-data", "after-revision", "after-history"])("resumes old JSON publication at %s exactly once", async id => {
    const base = filesystem();
    const overlay = await base.makeEditorOverlay("alice");
    const result = await publishOverlay(base, overlay, { collection: "pages", id });
    expect(result.failed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.published).toEqual([{ collection: "pages", id, revision: 8, deleted: false }]);
    expect(result.journalSources).toBeNull();
    // A fresh adapter verifies the on-disk upgrade and retry, not cached state.
    const restarted = filesystem();
    const restartedOverlay = await restarted.makeEditorOverlay("alice");
    expect((await restarted.getEntry("pages", id))?.data).toEqual({ title: "Approved", summary: "Keep me" });
    expect(await restarted.getRevision("pages", id)).toBe(8);
    expect(await restarted.getHistory("pages", id)).toEqual([{
      operationId: `frozen-${id}`, ts: 1700000000000, action: "publish",
      data: { title: "Original", summary: "Keep me" }, editor: { id: "alice" },
    }]);
    expect(await restartedOverlay.getEntry("pages", id)).toBeNull();
    expect((await publishOverlay(restarted, restartedOverlay, { collection: "pages", id })).published).toEqual([]);
    expect(await restarted.getRevision("pages", id)).toBe(8);
  });

  it.each(["source-before", "source-after", "source-history"])("resumes old Markdown publication at %s without a second splice", async id => {
    const base = markdown();
    const overlay = await base.makeEditorOverlay("alice");
    const original = JSON.parse(await readFile(join(root, "drafts/alice/data/blog", `${id}.json`), "utf8"));
    const result = await publishOverlay(base, overlay, { collection: "blog", id });
    expect(result.published).toEqual([{ collection: "blog", id, revision: 8, deleted: false }]);
    expect(result.failed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.journalSources).toBeNull();
    const restarted = markdown();
    expect(await restarted.readBodySource("blog", id)).toBe(original.__caret_publish__.afterSource);
    expect(await restarted.getRevision("blog", id)).toBe(8);
    expect(await restarted.getHistory("blog", id)).toEqual([original.__caret_publish__.history]);
    expect((await publishOverlay(restarted, await restarted.makeEditorOverlay("alice"), { collection: "blog", id })).published).toEqual([]);
  });

  it.each([
    ["pages", "delete-stage-0"], ["pages", "delete-stage-1"], ["pages", "delete-stage-3"],
    ["pages", "create-stage-0"], ["pages", "create-stage-1"],
    ["blog", "create-stage-0"], ["blog", "create-stage-1"],
    ["blog", "delete-stage-0"], ["blog", "delete-stage-3"],
  ])("recovers historical %s/%s creation or deletion", async (collection, id) => {
    const base = collection === "blog" ? markdown() : filesystem();
    const deleted = id.startsWith("delete-");
    const plan = JSON.parse(await readFile(join(root, "drafts/alice/data", collection, `${id}.json`), "utf8")).__caret_publish__;
    const result = await publishOverlay(base, await base.makeEditorOverlay("alice"), { collection, id });
    expect(result.failed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.published).toEqual([{ collection, id, revision: deleted ? 0 : 8, deleted }]);
    expect(result.journalSources).toBeNull();
    const restarted = collection === "blog" ? markdown() : filesystem();
    expect((await restarted.getEntry(collection, id))?.data ?? null).toEqual(deleted ? null : { title: "Created" });
    expect(await restarted.getRevision(collection, id)).toBe(8);
    expect(await restarted.getHistory(collection, id)).toEqual([plan.history]);
    const overlay = await restarted.makeEditorOverlay("alice");
    expect(await overlay.getEntry(collection, id)).toBeNull();
    expect((await publishOverlay(restarted, overlay, { collection, id })).published).toEqual([]);
    if (collection === "blog") {
      const source = await (restarted as MarkdownAdapter).readBodySource(collection, id);
      expect(deleted ? source : source?.includes("title: Created")).toBe(deleted ? null : true);
    }
  });

  it.each(["legacy-structured", "legacy-deletion"])("retains %s and refuses to invent a baseline", async id => {
    const base = filesystem();
    const overlay = await base.makeEditorOverlay("alice");
    const path = join(root, "drafts/alice/data/pages", `${id}.json`);
    const before = await readFile(path, "utf8");
    const result = await publishOverlay(base, overlay, { collection: "pages", id });
    expect(result.conflicts).toEqual([{ collection: "pages", id, reason: "legacy_draft" }]);
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await base.getEntry("pages", id))?.data.title).toBe("Original");
    expect(await base.getRevision("pages", id)).toBe(7);
    expect(await base.getHistory("pages", id)).toEqual([]);
  });

  it("publishes a legacy body-only draft using its frozen source hash", async () => {
    const base = markdown();
    const result = await publishOverlay(base, await base.makeEditorOverlay("alice"), { collection: "blog", id: "legacy-body" });
    expect(result.published).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(await base.readBodySource("blog", "legacy-body")).toBe('---\ntitle: Original\n---\n\nApproved paragraph.\n');
    expect(await base.getRevision("blog", "legacy-body")).toBe(8);
  });

  it("preserves a stale legacy body draft and later source", async () => {
    const base = markdown();
    const overlay = await base.makeEditorOverlay("alice");
    const source = await base.readBodySource("blog", "stale-body");
    const draft = await overlay.getEntry("blog", "stale-body");
    expect((await publishOverlay(base, overlay, { collection: "blog", id: "stale-body" })).conflicts)
      .toEqual([{ collection: "blog", id: "stale-body", reason: "stale_body" }]);
    expect(await base.readBodySource("blog", "stale-body")).toBe(source);
    expect(await overlay.getEntry("blog", "stale-body")).toEqual(draft);
    expect(await base.getRevision("blog", "stale-body")).toBe(7);
  });

  it.each(["intervening-edit", "invalid-plan"])("preserves old recovery information when %s cannot resume", async id => {
    const base = filesystem();
    const overlay = await base.makeEditorOverlay("alice");
    const data = await base.getEntry("pages", id);
    const path = join(root, "drafts/alice/data/pages", `${id}.json`);
    const raw = await readFile(path, "utf8");
    expect((await publishOverlay(base, overlay, { collection: "pages", id })).failed)
      .toEqual([{ collection: "pages", id, reason: "recovery_conflict" }]);
    expect(await base.getEntry("pages", id)).toEqual(data);
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(await base.getHistory("pages", id)).toEqual([]);
  });

  it("retains baseline semantics, private metadata, receipts, and editor isolation", async () => {
    const base = filesystem();
    const alice = await base.makeEditorOverlay("alice");
    const bob = await base.makeEditorOverlay("bob");
    const draft = new SessionOverlayAdapter(base, alice);
    expect(stripBodyOverlay((await draft.getEntry("pages", "tracked-draft"))!.data))
      .toEqual({ title: "Approved", summary: "Keep me" });
    expect(stripBodyOverlay((await draft.getEntry("pages", "before-write"))!.data))
      .toEqual({ title: "Approved", summary: "Keep me" });
    expect((await publishOverlay(base, alice, { collection: "pages", id: "tracked-draft" })).published).toHaveLength(1);
    expect(await base.getRevision("pages", "tracked-draft")).toBe(8);
    expect(await alice.getRebuildReceipt?.()).toEqual({ published: [{ collection: "pages", id: "after-history", revision: 8, deleted: false }], commit: null });
    expect(await bob.getRebuildReceipt?.()).toBeNull();
    expect(await base.getCollectionMetadata("orphan")).toBeNull();
    expect((await alice.getCollectionMetadata("orphan"))?.label).toBe("Legacy private collection");
    expect(await bob.listEntries("pages")).toEqual([]);
  });
});
