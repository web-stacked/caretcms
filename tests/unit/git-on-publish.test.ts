import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY } from "../../packages/core/src/runtime/draft-state";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { journalPublishedEntries } from "../../packages/core/src/runtime/publication-journal";
import { commitSnapshots } from "../../packages/core/src/runtime/git-journal";

/**
 * Integration: the W3 chain the publish route runs — draft edit → publishOverlay
 * flushes to the markdown source → commit-on-publish journals it to git. Mirrors
 * routes/publish.ts without the HTTP layer, in an isolated temp repo.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let dir: string;
let contentRoot: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-gitpub-"));
  contentRoot = join(dir, "src", "content");
  mkdirSync(join(contentRoot, "blog"), { recursive: true });
  writeFileSync(join(contentRoot, "blog", "hello.md"), "---\ntitle: Published\n---\nThe body.\n");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "repo@example.com");
  git(dir, "config", "user.name", "Repo");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed content");
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe("publish → markdown write → git commit", () => {
  it("flushes a draft to the .md and journals exactly that file to git", async () => {
    const base = new MarkdownAdapter({
      contentRoot,
      metaRoot: join(dir, ".caretcms"),
      draftsRoot: join(dir, ".caret", "drafts"),
    });
    const overlay = await base.makeEditorOverlay("editor-1");
    const draft = new SessionOverlayAdapter(base, overlay);

    // edit in the draft only — source + git untouched so far
    await draft.writeEntry("blog", "hello", { title: "Edited in draft" });
    expect(readFileSync(join(contentRoot, "blog", "hello.md"), "utf8")).toContain("title: Published");

    // publish: flush overlay → markdown source
    const { published, journalSources } = await publishOverlay(base, overlay, { collection: "blog", id: "hello" });
    expect(published).toHaveLength(1);
    const md = readFileSync(join(contentRoot, "blog", "hello.md"), "utf8");
    expect(md).toContain("title: Edited in draft");
    expect(md).toContain("The body."); // body preserved

    // Journal only the exact published source paths.
    const sha = await commitSnapshots({
      cwd: dir,
      sources: journalSources!,
      message: "publish blog/hello",
      authorName: "CaretCMS editor editor-1",
      authorEmail: "editor@caretcms.local",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "log", "-1", "--pretty=%s").trim()).toBe("publish blog/hello");
    expect(git(dir, "log", "-1", "--pretty=%an").trim()).toBe("CaretCMS editor editor-1");
    // the commit contains the edited markdown, and nothing from the draft/meta dirs
    const files = git(dir, "show", "--name-only", "--pretty=", "HEAD").trim().split("\n");
    expect(files).toEqual(["src/content/blog/hello.md"]);
  });
});

it("journals a recovered Markdown plan from its persisted bytes after an adapter restart", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const options = { contentRoot, metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") };
  const base = new MarkdownAdapter(options);
  const overlay = await base.makeEditorOverlay("recover-editor");
  await new SessionOverlayAdapter(base, overlay).writeEntry("blog", "hello", { title: "Approved recovery" });
  vi.spyOn(overlay, "deleteEntry").mockRejectedValueOnce(new Error("cleanup outage"));
  expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
  const restarted = new MarkdownAdapter(options);
  const restartedOverlay = await restarted.makeEditorOverlay("recover-editor");
  const { published, journalSources } = await publishOverlay(restarted, restartedOverlay);
  expect(published).toHaveLength(1);
  const approved = readFileSync(join(contentRoot, "blog/hello.md"), "utf8");
  writeFileSync(join(contentRoot, "blog/hello.md"), "---\ntitle: Later edit\n---\nLater body\n");
  expect(await commitSnapshots({ cwd: dir, sources: journalSources!, message: "publish recovered content" })).toBeTruthy();
  expect(git(dir, "show", "HEAD:src/content/blog/hello.md")).toBe(approved);
  expect(readFileSync(join(contentRoot, "blog/hello.md"), "utf8")).toContain("Later body");
});

it("journals both deleted Markdown extensions and leaves a later recreation untouched", async () => {
  writeFileSync(join(contentRoot, "blog/hello.mdx"), "---\ntitle: Alternate\n---\nexport const x = 1;\n");
  git(dir, "add", "src/content/blog/hello.mdx"); git(dir, "commit", "-qm", "add alternate");
  const base = new MarkdownAdapter({ contentRoot, metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") });
  const overlay = await base.makeEditorOverlay("delete-editor");
  await new SessionOverlayAdapter(base, overlay).deleteEntry("blog", "hello");
  const { journalSources } = await publishOverlay(base, overlay);
  expect(journalSources).toHaveLength(2);
  writeFileSync(join(contentRoot, "blog/hello.md"), "Recreated after publish\n");
  expect(await commitSnapshots({ cwd: dir, sources: journalSources!, message: "publish deletion" })).toBeTruthy();
  expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").trim()).toBe("");
  expect(readFileSync(join(contentRoot, "blog/hello.md"), "utf8")).toBe("Recreated after publish\n");
});

it("journals the exact JSON serialization after its working file is changed", async () => {
  const base = new FilesystemAdapter({ dataRoot: join(dir, "data"), metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") });
  const overlay = await base.makeEditorOverlay("json-editor");
  const data = { title: "Approved JSON", nested: { enabled: true }, text: "A & B" };
  await new SessionOverlayAdapter(base, overlay).writeEntry("pages", "home", data);
  const { journalSources } = await publishOverlay(base, overlay);
  const approved = readFileSync(join(dir, "data/pages/home.json"), "utf8");
  writeFileSync(join(dir, "data/pages/home.json"), '{"title":"External JSON"}\n');
  expect(await commitSnapshots({ cwd: dir, sources: journalSources!, message: "publish JSON" })).toBeTruthy();
  expect(git(dir, "show", "HEAD:data/pages/home.json")).toBe(approved);
  expect(approved).toBe(JSON.stringify(data, null, 2) + "\n");
});

it("recovers old plans without manufacturing journal bytes from later working files", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const base = new MarkdownAdapter({ contentRoot, metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") });
  const overlay = await base.makeEditorOverlay("old-plan-editor");
  await new SessionOverlayAdapter(base, overlay).writeEntry("blog", "hello", { title: "Approved old plan" });
  vi.spyOn(overlay, "deleteEntry").mockRejectedValueOnce(new Error("cleanup outage"));
  expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
  const stored = (await overlay.getEntry("blog", "hello"))!;
  const plan = stored.data[PUBLISH_RECOVERY_KEY] as Record<string, unknown>;
  delete plan.journalSources;
  expect(stored.data[DRAFT_STATE_KEY]).toBeDefined();
  await overlay.writeEntry("blog", "hello", stored.data);
  const recovered = await publishOverlay(base, overlay);
  expect(recovered.published).toHaveLength(1);
  expect(recovered.journalSources).toBeNull();
});

it("recovers a new Markdown source after a lost write acknowledgement and journals its original bytes", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const options = { contentRoot, metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") };
  const base = new MarkdownAdapter(options);
  const overlay = await base.makeEditorOverlay("new-source-editor");
  await new SessionOverlayAdapter(base, overlay).writeEntry("blog", "new", { title: "Approved new source" });
  const write = base.writeBodySource.bind(base);
  vi.spyOn(base, "writeBodySource").mockImplementationOnce(async (...args) => {
    await write(...args); throw new Error("lost acknowledgement");
  });
  expect((await publishOverlay(base, overlay)).failed).toHaveLength(1);
  const saved = (await overlay.getEntry("blog", "new"))!.data[PUBLISH_RECOVERY_KEY] as { afterSource: string };
  expect(saved.afterSource).toContain("title: Approved new source");
  const restarted = new MarkdownAdapter(options);
  const recovered = await publishOverlay(restarted, await restarted.makeEditorOverlay("new-source-editor"));
  expect(recovered.published).toHaveLength(1);
  expect(await restarted.getRevision("blog", "new")).toBe(1);
  expect(await restarted.getHistory("blog", "new")).toHaveLength(1);
  writeFileSync(join(contentRoot, "blog/new.md"), "Later source edit\n");
  expect(await commitSnapshots({ cwd: dir, sources: recovered.journalSources!, message: "publish new source" })).toBeTruthy();
  expect(git(dir, "show", "HEAD:src/content/blog/new.md")).toBe(saved.afterSource);
  expect(readFileSync(join(contentRoot, "blog/new.md"), "utf8")).toBe("Later source edit\n");
});

it("skips an older delayed journal after a newer publication has committed", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const base = new MarkdownAdapter({ contentRoot, metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") });
  const alice = await base.makeEditorOverlay("alice");
  await new SessionOverlayAdapter(base, alice).writeEntry("blog", "hello", { title: "Older approved" });
  const older = await publishOverlay(base, alice);
  const bob = await base.makeEditorOverlay("bob");
  await new SessionOverlayAdapter(base, bob).writeEntry("blog", "hello", { title: "Newer approved" });
  const newer = await publishOverlay(base, bob);
  const sha = await journalPublishedEntries(base, newer.journalVersions, { cwd: dir, sources: newer.journalSources!, message: "newer" });
  expect(sha).toBeTruthy();
  expect(await journalPublishedEntries(base, older.journalVersions, { cwd: dir, sources: older.journalSources!, message: "older" })).toBeNull();
  expect(git(dir, "rev-parse", "HEAD").trim()).toBe(sha);
  expect(git(dir, "show", "HEAD:src/content/blog/hello.md")).toContain("title: Newer approved");
});

it("holds the entry lock through journaling so a later publication follows the older commit", async () => {
  const base = new MarkdownAdapter({ contentRoot, metaRoot: join(dir, "meta"), draftsRoot: join(dir, "drafts") });
  const alice = await base.makeEditorOverlay("alice");
  await new SessionOverlayAdapter(base, alice).writeEntry("blog", "hello", { title: "First approved" });
  const first = await publishOverlay(base, alice);
  const bob = await base.makeEditorOverlay("bob");
  await new SessionOverlayAdapter(base, bob).writeEntry("blog", "hello", { title: "Second approved" });
  let observed!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { observed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const revision = base.getRevision.bind(base);
  vi.spyOn(base, "getRevision").mockImplementationOnce(async (...args) => { observed(); await gate; return revision(...args); });
  const journal = journalPublishedEntries(base, first.journalVersions, { cwd: dir, sources: first.journalSources!, message: "first" });
  await entered;
  const secondPublish = publishOverlay(base, bob);
  release();
  const firstSha = await journal;
  expect(firstSha).toBeTruthy();
  const second = await secondPublish;
  expect(second.published).toHaveLength(1);
  const secondSha = await journalPublishedEntries(base, second.journalVersions, { cwd: dir, sources: second.journalSources!, message: "second" });
  expect(secondSha).toBeTruthy();
  expect(git(dir, "rev-parse", "HEAD^").trim()).toBe(firstSha);
  expect(git(dir, "show", "HEAD:src/content/blog/hello.md")).toContain("title: Second approved");
});
