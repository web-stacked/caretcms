import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { getGitJournalTarget, readGitJournalCommit } from "../../packages/core/src/runtime/git-journal";
import { retryPublicationJournals } from "../../packages/core/src/runtime/publication-journal";
import { PUBLISH_RECOVERY_KEY } from "../../packages/core/src/runtime/draft-state";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import type { GitJournalReceipt, StorageAdapter } from "../../packages/core/src/types";

let dir: string;
let source: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const base = () => new MarkdownAdapter({ contentRoot: join(dir, "src/content"), metaRoot: join(dir, ".caretcms"), draftsRoot: join(dir, ".caret/drafts") });
const queue = () => base().makeEditorOverlay("alice");
const journalOptions = async () => ({ journal: { target: (await getGitJournalTarget(dir))!, authorName: "Editor", authorEmail: "editor@example.invalid" } });
async function publish(title = "Approved") {
  const published = base(), raw = await queue();
  await new SessionOverlayAdapter(published, raw).writeEntry("blog", "hello", { title });
  const result = await publishOverlay(published, raw, {}, await journalOptions());
  expect(result.failed).toEqual([]);
  expect(result.published).toHaveLength(1);
  return { published, raw, receipt: (await raw.listGitJournalReceipts!())[0] };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-journal-retry-"));
  source = join(dir, "src/content/blog/hello.md");
  mkdirSync(join(dir, "src/content/blog"), { recursive: true });
  writeFileSync(source, "---\ntitle: Original\n---\nBody.\n");
  writeFileSync(join(dir, ".gitignore"), ".caret/\n.caretcms/\n");
  writeFileSync(join(dir, "other.txt"), "Original other\n");
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("add", "."); git("commit", "-qm", "seed");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it("retains approved source bytes after draft cleanup and journals them after reopening adapters", async () => {
  const { raw, receipt } = await publish();
  expect(await raw.getEntry("blog", "hello")).toBeNull();
  expect(receipt).toMatchObject({ version: 1, collection: "blog", id: "hello", revision: 1, deleted: false });
  expect(receipt.sources[0].content).toContain("Approved");
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ completed: 1, pending: 0, blocked: 0 });
  expect(git("show", "HEAD:src/content/blog/hello.md")).toContain("Approved");
  expect(await (await queue()).listGitJournalReceipts!()).toEqual([]);
  expect(await base().getRevision("blog", "hello")).toBe(1);
  expect(await base().getHistory("blog", "hello")).toHaveLength(1);
});

it("recovers a receipt after the publishing process is killed before Git journaling", async () => {
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(process.cwd(), "packages/core/dist/runtime", name)).href);
  const script = `
    import { MarkdownAdapter } from ${moduleUrl("storage/markdown-adapter.js")};
    import { SessionOverlayAdapter } from ${moduleUrl("storage/session-overlay-adapter.js")};
    import { publishOverlay } from ${moduleUrl("publish.js")};
    import { getGitJournalTarget } from ${moduleUrl("git-journal.js")};
    import { join } from 'node:path';
    const dir = process.argv[1];
    const base = new MarkdownAdapter({ contentRoot: join(dir, 'src/content'), metaRoot: join(dir, '.caretcms'), draftsRoot: join(dir, '.caret/drafts') });
    const raw = await base.makeEditorOverlay('alice');
    await new SessionOverlayAdapter(base, raw).writeEntry('blog', 'hello', { title: 'Approved after process death' });
    const result = await publishOverlay(base, raw, {}, { journal: { target: await getGitJournalTarget(dir), authorName: 'Editor', authorEmail: 'editor@example.invalid' } });
    if (result.published.length !== 1 || result.failed.length || await raw.getEntry('blog', 'hello')) process.exit(2);
    process.kill(process.pid, 'SIGKILL');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir], { encoding: "utf8", timeout: 15_000 });
  expect(child.stderr).toBe("");
  expect(child.signal).toBe("SIGKILL");
  expect(await (await queue()).listGitJournalReceipts!()).toHaveLength(1);
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ completed: 1, pending: 0 });
  expect(git("show", "HEAD:src/content/blog/hello.md")).toContain("Approved after process death");
  expect(await base().getRevision("blog", "hello")).toBe(1);
  expect(await base().getHistory("blog", "hello")).toHaveLength(1);
});

it("retains publication recovery when receipt persistence fails, then completes bookkeeping exactly once", async () => {
  const published = base(), raw = await queue();
  await new SessionOverlayAdapter(published, raw).writeEntry("blog", "hello", { title: "Approved" });
  const save = vi.spyOn(raw, "saveGitJournalReceipt").mockRejectedValueOnce(new Error("Disk unavailable"));
  expect((await publishOverlay(published, raw, {}, await journalOptions())).failed).toHaveLength(1);
  const plan = (await raw.getEntry("blog", "hello"))!.data[PUBLISH_RECOVERY_KEY] as { history: { operationId: string } };
  expect(plan.history.operationId).toBeTruthy();
  expect(await published.getRevision("blog", "hello")).toBe(1);
  save.mockRestore();
  expect((await publishOverlay(base(), await queue(), {}, await journalOptions())).published).toHaveLength(1);
  const receipt = (await (await queue()).listGitJournalReceipts!())[0];
  expect(receipt.operationId).toBe(plan.history.operationId);
  expect(await base().getHistory("blog", "hello")).toHaveLength(1);
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ completed: 1, pending: 0 });
});

it("does not journal a receipt while the same publication's cleanup still needs recovery", async () => {
  const published = base(), raw = await queue();
  await new SessionOverlayAdapter(published, raw).writeEntry("blog", "hello", { title: "Approved" });
  const save = raw.saveGitJournalReceipt!.bind(raw);
  vi.spyOn(raw, "saveGitJournalReceipt").mockImplementationOnce(async receipt => { await save(receipt); throw new Error("Lost queue acknowledgement"); });
  expect((await publishOverlay(published, raw, {}, await journalOptions())).failed).toHaveLength(1);
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ completed: 0, pending: 1 });
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
  expect((await publishOverlay(base(), await queue())).published).toHaveLength(1);
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ completed: 1, pending: 0 });
});

it("keeps a busy index's receipt and lock untouched, then retries without republishing", async () => {
  const { raw } = await publish();
  writeFileSync(join(dir, ".git/index.lock"), "Other writer's lock");
  expect(await retryPublicationJournals(base(), raw, dir)).toMatchObject({ pending: 1, completed: 0 });
  expect(readFileSync(join(dir, ".git/index.lock"), "utf8")).toBe("Other writer's lock");
  rmSync(join(dir, ".git/index.lock"));
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ pending: 0, completed: 1 });
  expect(await base().getRevision("blog", "hello")).toBe(1);
  expect(await base().getHistory("blog", "hello")).toHaveLength(1);
});

it("retains deletion receipts and journals removal without recreating content or reusing its revision", async () => {
  const published = base(), raw = await queue();
  await new SessionOverlayAdapter(published, raw).deleteEntry("blog", "hello");
  expect((await publishOverlay(published, raw, {}, await journalOptions())).published).toMatchObject([{ deleted: true }]);
  const receipt = (await raw.listGitJournalReceipts!())[0];
  expect(receipt).toMatchObject({ deleted: true, revision: 1 });
  expect(receipt.sources.length).toBeGreaterThan(0);
  expect(receipt.sources.every(source => source.content === null)).toBe(true);
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ completed: 1, pending: 0 });
  expect(git("ls-tree", "HEAD", "src/content/blog/hello.md")).toBe("");
  expect(await base().getEntry("blog", "hello")).toBeNull();
  expect(await base().getRevision("blog", "hello")).toBe(1);
  expect(await base().getHistory("blog", "hello")).toHaveLength(1);
});

it("journals a filesystem JSON receipt after reopening its private queue", async () => {
  const create = () => new FilesystemAdapter({ dataRoot: join(dir, "data"), metaRoot: join(dir, ".caretcms"), draftsRoot: join(dir, ".caret/drafts") });
  const published = create(), raw = await published.makeEditorOverlay("alice");
  await published.writeEntry("blog", "hello", { title: "Original" });
  git("add", "data"); git("commit", "-qm", "seed JSON");
  await new SessionOverlayAdapter(published, raw).writeEntry("blog", "hello", { title: "Approved" });
  expect((await publishOverlay(published, raw, {}, await journalOptions())).failed).toEqual([]);
  expect(await retryPublicationJournals(create(), await create().makeEditorOverlay("alice"), dir)).toMatchObject({ completed: 1, pending: 0 });
  expect(JSON.parse(git("show", "HEAD:data/blog/hello.json"))).toEqual({ title: "Approved" });
  expect(await published.getRevision("blog", "hello")).toBe(1);
});

it("acknowledges a marked commit after failed queue cleanup even when content subsequently advances", async () => {
  const { published, raw, receipt } = await publish();
  vi.spyOn(raw, "deleteGitJournalReceipt").mockRejectedValueOnce(new Error("Queue unavailable"));
  const first = await retryPublicationJournals(published, raw, dir);
  expect(first).toMatchObject({ pending: 1, completed: 0, commit: expect.any(String) });
  expect(await readGitJournalCommit(dir, { operationId: receipt.operationId, target: receipt.target })).toBe(first.commit);
  await published.bumpRevision("blog", "hello");
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ pending: 0, completed: 1, commit: first.commit });
  expect(git("rev-list", "--count", "HEAD")).toBe("2");
});

it("holds unjournaled stale receipts instead of putting older content over a newer publication", async () => {
  const { raw } = await publish();
  await base().writeEntry("blog", "hello", { title: "Newer" });
  await base().bumpRevision("blog", "hello");
  const head = git("rev-parse", "HEAD");
  expect(await retryPublicationJournals(base(), raw, dir)).toEqual({ completed: 0, pending: 1, blocked: 1, commit: null });
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect((await base().getEntry("blog", "hello"))?.data.title).toBe("Newer");
  expect(await raw.listGitJournalReceipts!()).toHaveLength(1);
});

it("refuses a different branch and resumes when the captured checkout is restored", async () => {
  const { raw } = await publish();
  const original = git("symbolic-ref", "--short", "HEAD");
  git("checkout", "-qb", "other");
  const head = git("rev-parse", "HEAD");
  expect(await retryPublicationJournals(base(), raw, dir)).toMatchObject({ pending: 1, completed: 0 });
  expect(git("rev-parse", "HEAD")).toBe(head);
  git("checkout", "-q", original);
  expect(await retryPublicationJournals(base(), raw, dir)).toMatchObject({ pending: 0, completed: 1 });
});

it("records an already-current approved tree without creating an empty commit", async () => {
  const { raw } = await publish("Original");
  const head = git("rev-parse", "HEAD"), index = readFileSync(join(dir, ".git/index"));
  expect(await retryPublicationJournals(base(), raw, dir)).toMatchObject({ pending: 0, completed: 1, commit: head });
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
});

it("does not replay a journal whose marker was removed from the branch ancestry", async () => {
  const { published, raw, receipt } = await publish();
  const oldHead = git("rev-parse", "HEAD");
  vi.spyOn(raw, "deleteGitJournalReceipt").mockRejectedValueOnce(new Error("Queue unavailable"));
  await retryPublicationJournals(published, raw, dir);
  git("update-ref", receipt.target.ref, oldHead);
  expect(await retryPublicationJournals(base(), await queue(), dir)).toMatchObject({ pending: 1, completed: 0 });
  expect(git("rev-parse", "HEAD")).toBe(oldHead);
});

it("preserves later working edits and separately staged source and unrelated edits", async () => {
  const { raw, receipt } = await publish();
  writeFileSync(source, "---\ntitle: Later developer edit\n---\nBody.\n");
  writeFileSync(join(dir, "other.txt"), "Staged other\n");
  git("add", "src/content/blog/hello.md", "other.txt");
  expect(await retryPublicationJournals(base(), raw, dir)).toMatchObject({ pending: 0, completed: 1 });
  expect(git("show", "HEAD:src/content/blog/hello.md")).toBe(receipt.sources[0].content!.trim());
  expect(git("show", ":src/content/blog/hello.md")).toContain("Later developer edit");
  expect(git("show", ":other.txt")).toBe("Staged other");
  expect(readFileSync(source, "utf8")).toContain("Later developer edit");
});

it("preflights all queued publish and deletion permissions before writing Git history", async () => {
  const { published, raw, receipt } = await publish();
  const denied: GitJournalReceipt = { ...receipt, operationId: crypto.randomUUID(), id: "other", deleted: true };
  await raw.saveGitJournalReceipt!(denied);
  const head = git("rev-parse", "HEAD");
  await expect(runWithRequestContext({ adapter: published, uploadHandler: { upload: vi.fn() }, sessionId: null, demoMode: false,
    authorize: async (action, _collection, id) => action !== "delete" || id !== "other" }, () => retryPublicationJournals(published, raw, dir)))
    .rejects.toThrow("Permission denied");
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(await raw.listGitJournalReceipts!()).toHaveLength(2);
});

it("keeps receipt metadata isolated from other editors and ordinary content indexes", async () => {
  const { raw } = await publish();
  expect(await (await base().makeEditorOverlay("bob")).listGitJournalReceipts!()).toEqual([]);
  expect(await raw.listEntryIds("blog")).toEqual([]);
  expect(await raw.discoverCollections()).not.toContain("git-journal");
});

it("rejects changed immutable receipts and corrupt queue data instead of resetting the queue", async () => {
  const { raw, receipt } = await publish();
  await raw.saveGitJournalReceipt!(receipt);
  await expect(raw.saveGitJournalReceipt!({ ...receipt, sources: [{ ...receipt.sources[0], content: "Changed approval" }] })).rejects.toThrow("changed");
  const name = createHash("sha256").update(receipt.operationId).digest("hex");
  writeFileSync(join(dir, ".caret/drafts/alice/meta/git-journal", `${name}.json`), "{broken");
  await expect(raw.listGitJournalReceipts!()).rejects.toThrow();
  await expect(retryPublicationJournals(base(), raw, dir)).rejects.toThrow();
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
});

it("ignores abandoned atomic-write temporary files without treating them as receipts", async () => {
  const { raw, receipt } = await publish();
  const name = createHash("sha256").update(receipt.operationId).digest("hex");
  writeFileSync(join(dir, ".caret/drafts/alice/meta/git-journal", `${name}.json.${crypto.randomUUID()}.tmp`), "partial write");
  expect(await raw.listGitJournalReceipts!()).toHaveLength(1);
  expect(await retryPublicationJournals(base(), raw, dir)).toMatchObject({ pending: 0, completed: 1 });
});

it("retains the draft without applying content when durable source preparation is unavailable", async () => {
  const published = base(), raw = await queue();
  await new SessionOverlayAdapter(published, raw).writeEntry("blog", "hello", { title: "Approved" });
  vi.spyOn(published, "preparePublicationSources").mockRejectedValueOnce(new Error("Cannot capture approval"));
  expect((await publishOverlay(published, raw, {}, await journalOptions())).failed).toHaveLength(1);
  expect((await published.getEntry("blog", "hello"))?.data.title).toBe("Original");
  expect(await raw.getEntry("blog", "hello")).not.toBeNull();
  expect(await raw.listGitJournalReceipts!()).toEqual([]);
});
