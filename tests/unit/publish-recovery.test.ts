import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { publishOverlay, discardOverlay } from "../../packages/core/src/runtime/publish";
import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY } from "../../packages/core/src/runtime/draft-state";
import { stripBodyOverlay } from "../../packages/core/src/runtime/utils";
import { canonicalBody } from "../../packages/core/src/markdown/canonical-body";
import { fnv1a32 } from "../../packages/core/src/markdown/contracts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const base = new InMemoryAdapter();
  await base.writeEntry("pages", "home", { title: "Original", section: "Original section" });
  const overlay = await base.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(base, overlay);
  return { base, overlay, draft };
}
async function save(draft: SessionOverlayAdapter, field: string, value: string) {
  expect((await executeMutation(draft, { type: "save_field", collection: "pages", id: "home", field, value })).ok).toBe(true);
}

describe("draft baseline protection", () => {
  it.each(["title", "section"])("rejects a stale draft when the other editor changed %s", async field => {
    const { base, overlay, draft } = await fixture();
    const bob = await base.makeEditorOverlay("bob");
    await save(draft, "title", "Alice");
    await save(new SessionOverlayAdapter(base, bob), field, "Bob");
    expect((await publishOverlay(base, bob)).published).toHaveLength(1);
    const before = await base.getEntry("pages", "home");
    const outcome = await publishOverlay(base, overlay);
    expect(outcome.conflicts).toEqual([{ collection: "pages", id: "home", reason: "stale_entry" }]);
    expect(await base.getEntry("pages", "home")).toEqual(before);
    expect(await overlay.getEntry("pages", "home")).not.toBeNull();
  });

  it("detects external source edits even without a revision bump", async () => {
    const { base, overlay, draft } = await fixture();
    await save(draft, "title", "Alice");
    await base.writeEntry("pages", "home", { title: "External" });
    expect((await publishOverlay(base, overlay)).conflicts[0].reason).toBe("stale_entry");
  });

  it("protects deletion and delete/recreate ABA changes", async () => {
    const { base, overlay, draft } = await fixture();
    await draft.deleteEntry("pages", "home");
    await base.bumpRevision("pages", "home");
    expect((await publishOverlay(base, overlay)).conflicts[0].reason).toBe("stale_entry");
    expect(await base.getEntry("pages", "home")).not.toBeNull();
  });

  it("rejects legacy structured drafts rather than inventing their baseline", async () => {
    const { base, overlay } = await fixture();
    await overlay.writeEntry("pages", "home", { title: "Old draft" });
    expect((await publishOverlay(base, overlay)).conflicts[0].reason).toBe("legacy_draft");
  });

  it("whole-entry saves can remove fields without resurrecting them at publish", async () => {
    const { base, overlay, draft } = await fixture();
    await draft.writeEntry("pages", "home", { title: "Only title" });
    expect((await draft.getEntry("pages", "home"))?.data).toEqual({ title: "Only title" });
    expect((await publishOverlay(base, overlay)).published).toHaveLength(1);
    expect((await base.getEntry("pages", "home"))?.data).toEqual({ title: "Only title" });
  });

  it.each([DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY, "__caret_tombstone__"])("blocks browser writes to %s and strips it from reads", async key => {
    const { draft } = await fixture();
    expect((await executeMutation(draft, { type: "save_field", collection: "pages", id: "home", field: key + ".version", value: "1" })).ok).toBe(false);
    expect((await executeMutation(draft, { type: "put_entry", collection: "pages", id: "home", data: { [key]: {} } })).ok).toBe(false);
    expect(stripBodyOverlay({ title: "Visible", [key]: { secret: true } })).toEqual({ title: "Visible" });
  });
});

describe("recoverable publish", () => {
  it.each(["writeEntry", "bumpRevision", "appendHistory"] as const)("resumes after %s fails before or after persistence", async method => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const after of [false, true]) {
      const { base, overlay, draft } = await fixture();
      await save(draft, "title", "Published");
      const original = base[method].bind(base) as (...args: unknown[]) => Promise<unknown>;
      const spy = vi.spyOn(base, method).mockImplementationOnce(async (...args: unknown[]) => {
        if (after) await original(...args);
        throw new Error("storage failure");
      });
      const failed = await publishOverlay(base, overlay);
      expect(failed.failed).toHaveLength(1);
      expect((await overlay.getEntry("pages", "home"))?.data[PUBLISH_RECOVERY_KEY]).toBeDefined();
      spy.mockRestore();
      const recovered = await publishOverlay(base, overlay);
      expect(recovered.failed).toEqual([]);
      expect(recovered.published).toHaveLength(1);
      expect((await base.getEntry("pages", "home"))?.data.title).toBe("Published");
      expect(await base.getRevision("pages", "home")).toBe(1);
      expect(await base.getHistory("pages", "home")).toHaveLength(1);
      expect((await publishOverlay(base, overlay)).published).toEqual([]);
    }
  });

  it("recovers failed draft cleanup without duplicate revisions/history", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { base, overlay, draft } = await fixture();
    await save(draft, "title", "Published");
    vi.spyOn(overlay, "deleteEntry").mockRejectedValueOnce(new Error("cleanup failure"));
    expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
    expect((await publishOverlay(base, overlay)).published).toHaveLength(1);
    expect(await base.getHistory("pages", "home")).toHaveLength(1);
    expect(await base.getRevision("pages", "home")).toBe(1);
  });

  it("reports completed entries when a later entry fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { base, overlay, draft } = await fixture();
    await save(draft, "title", "Published");
    await draft.writeEntry("pages", "later", { title: "Later" });
    const append = base.appendHistory.bind(base);
    vi.spyOn(base, "appendHistory").mockImplementation(async (c, id, h) => { if (id === "later") throw new Error("history failed"); await append(c, id, h); });
    const result = await publishOverlay(base, overlay);
    expect(result.published.map(entry => entry.id)).toEqual(["home"]);
    expect(result.failed.map(entry => entry.id)).toEqual(["later"]);
  });

  it("does not overwrite an intervening edit or discard its recovery information", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { base, overlay, draft } = await fixture();
    await save(draft, "title", "Published");
    vi.spyOn(base, "appendHistory").mockRejectedValueOnce(new Error("history failed"));
    await publishOverlay(base, overlay);
    await expect(draft.writeEntry("pages", "home", { title: "Another draft" })).rejects.toThrow(/pending publication/);
    await expect(discardOverlay(overlay)).rejects.toThrow(/pending publication/);
    await base.writeEntry("pages", "home", { title: "Intervening edit" });
    expect((await publishOverlay(base, overlay)).failed[0].reason).toBe("recovery_conflict");
    expect((await base.getEntry("pages", "home"))?.data.title).toBe("Intervening edit");
  });

  it("resumes a Markdown history failure through a fresh adapter after restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "caret-publish-recovery-")); roots.push(root);
    const options = { contentRoot: join(root, "content"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") };
    await mkdir(join(root, "content/blog"), { recursive: true });
    const path = join(root, "content/blog/post.md");
    const source = '---\ntitle: Original\n---\n\nOriginal paragraph.\n';
    await writeFile(path, source);
    const base = new MarkdownAdapter(options);
    const overlay = await base.makeEditorOverlay("alice");
    const { body } = canonicalBody(source);
    const draft = new SessionOverlayAdapter(base, overlay);
    expect((await executeMutation(draft, { type: "md_block", collection: "blog", id: "post", blockPath: "0", src: `0:${body.length}:${fnv1a32(body)}`, html: "Changed paragraph." })).ok).toBe(true);
    const history = join(root, "meta/history/blog/post.json");
    await mkdir(history, { recursive: true });
    expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
    expect(await readFile(path, "utf8")).toContain("Changed paragraph.");
    await rm(history, { recursive: true });
    const restarted = new MarkdownAdapter(options);
    const result = await publishOverlay(restarted, await restarted.makeEditorOverlay("alice"));
    expect(result.conflicts).toEqual([]); expect(result.failed).toEqual([]);
    expect(result.published).toHaveLength(1);
    expect(await restarted.getRevision("blog", "post")).toBe(1);
    expect(await restarted.getHistory("blog", "post")).toHaveLength(1);
    expect((await restarted.getHistory("blog", "post"))[0].bodySource).toBe(source);
  });
});

it.each(["before", "after"] as const)("recovers a combined Markdown/frontmatter write failure %s persistence", async timing => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "caret-source-recovery-")); roots.push(root);
  const options = { contentRoot: join(root, "content"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") };
  await mkdir(join(root, "content/blog"), { recursive: true });
  const path = join(root, "content/blog/post.md");
  const source = '---\ntitle: Original\n---\n\nOriginal paragraph.\n';
  await writeFile(path, source);
  const base = new MarkdownAdapter(options);
  const overlay = await base.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(base, overlay);
  const { body } = canonicalBody(source);
  expect((await executeMutation(draft, { type: "md_block", collection: "blog", id: "post", blockPath: "0", src: `0:${body.length}:${fnv1a32(body)}`, html: "Changed paragraph." })).ok).toBe(true);
  expect((await executeMutation(draft, { type: "put_entry", collection: "blog", id: "post", data: { title: "Changed title" } })).ok).toBe(true);
  const write = base.writeBodySource.bind(base);
  vi.spyOn(base, "writeBodySource").mockImplementationOnce(async (...args) => {
    if (timing === "after") await write(...args);
    throw new Error("lost source write acknowledgement");
  });
  expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
  expect((await publishOverlay(base, overlay)).published).toHaveLength(1);
  expect((await base.getEntry("blog", "post"))?.data.title).toBe("Changed title");
  expect(await readFile(path, "utf8")).toContain("Changed paragraph.");
  expect(await base.getRevision("blog", "post")).toBe(1);
  expect(await base.getHistory("blog", "post")).toHaveLength(1);
});
