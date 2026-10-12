import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POST } from "../../packages/core/src/runtime/routes/publish";
import { GET } from "../../packages/core/src/runtime/routes/draft";
import { issueEditorSessionCookie, getEditorId } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";

let dir: string;
let base: MarkdownAdapter;
let cookies: { get(name: string): { value: string } | undefined };
let fetchSpy: ReturnType<typeof vi.spyOn>;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const post = (body: object = {}) => POST({ cookies, request: new Request("https://site.test/api/cms/publish", {
  method: "POST", headers: { "x-caret-request": "1" }, body: JSON.stringify(body),
}) } as never);
const state = () => GET({ cookies } as never);
const raw = () => base.makeEditorOverlay(getEditorId({ cookies })!);
const draft = async () => new SessionOverlayAdapter(base, await raw()).writeEntry("blog", "hello", { title: "Approved" });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "caret-route-journal-"));
  mkdirSync(join(dir, "src/content/blog"), { recursive: true });
  writeFileSync(join(dir, "src/content/blog/hello.md"), "---\ntitle: Original\n---\nBody.\n");
  writeFileSync(join(dir, ".gitignore"), ".caret/\n.caretcms/\n");
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("add", "."); git("commit", "-qm", "seed");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("CARET_SESSION_SECRET", "test-secret");
  vi.stubEnv("CARET_GIT_ON_PUBLISH", "true");
  vi.stubEnv("CARET_GIT_JOURNAL_RETRY", "true");
  const session = issueEditorSessionCookie("/").split(";")[0].split("=").slice(1).join("=");
  cookies = { get: name => name === "caret_session" ? { value: session } : undefined };
  base = new MarkdownAdapter({ contentRoot: join(dir, "src/content"), metaRoot: join(dir, ".caretcms"), draftsRoot: join(dir, ".caret/drafts") });
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("accepted", { status: 202 }));
  __setRuntimeServicesForTests({ adapter: base, uploadHandler: { async upload() { return { url: "/unused" }; } },
    delivery: { mode: "static", bake: true, publish: { webhookUrl: "https://deploy.example/hook", method: "POST", headers: {} } } });
  await draft();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); __setRuntimeServicesForTests(null); rmSync(dir, { recursive: true, force: true }); });

it("publishes with pending Git history, then retries only the private Git queue", async () => {
  writeFileSync(join(dir, ".git/index.lock"), "Another writer");
  const first = await (await post()).json();
  expect(first).toMatchObject({ ok: true, published: [{ collection: "blog", id: "hello" }], journal: { pending: 1, completed: 0 }, journalRetryAvailable: true, rebuild: { ok: true } });
  expect(await (await state()).json()).toMatchObject({ count: 0, retryJournal: true, journalPending: 1 });
  const revision = await base.getRevision("blog", "hello"), history = await base.getHistory("blog", "hello");
  expect(await (await raw()).getEntry("blog", "hello")).toBeNull();
  rmSync(join(dir, ".git/index.lock"));
  const retry = await (await post({ retryJournal: true })).json();
  expect(retry).toMatchObject({ published: [], journal: { pending: 0, completed: 1 }, journalRetryAvailable: false, rebuild: { triggered: false, ok: true } });
  expect(JSON.stringify(retry)).not.toMatch(/Approved|src\/content|operationId|authorEmail|gitDir/);
  expect(await base.getRevision("blog", "hello")).toBe(revision);
  expect(await base.getHistory("blog", "hello")).toEqual(history);
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(git("rev-list", "--count", "HEAD")).toBe("2");
  expect(git("show", "HEAD:src/content/blog/hello.md")).toContain("Approved");
  expect(await (await state()).json()).not.toHaveProperty("journalPending");
});

it("keeps existing best-effort journaling when durable retry is disabled", async () => {
  vi.stubEnv("CARET_GIT_JOURNAL_RETRY", "false");
  const result = await (await post()).json();
  expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(result).not.toHaveProperty("journal");
  expect(await (await raw()).listGitJournalReceipts!()).toEqual([]);
  expect((await post({ retryJournal: true })).status).toBe(400);
});

it("refuses unavailable Git before applying content in durable mode", async () => {
  rmSync(join(dir, ".git"), { recursive: true });
  expect((await post()).status).toBe(400);
  expect((await base.getEntry("blog", "hello"))?.data.title).toBe("Original");
  expect(await base.getRevision("blog", "hello")).toBe(0);
  expect(await (await raw()).getEntry("blog", "hello")).not.toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("does not expose another editor's private queue", async () => {
  writeFileSync(join(dir, ".git/index.lock"), "Another writer");
  await post();
  const session = issueEditorSessionCookie("/").split(";")[0].split("=").slice(1).join("=");
  cookies = { get: name => name === "caret_session" ? { value: session } : undefined };
  expect(await (await state()).json()).not.toHaveProperty("journalPending");
  expect(await (await post({ retryJournal: true })).json()).toMatchObject({ journal: { pending: 0, completed: 0 } });
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
});

it("preflights retry permissions before Git changes and hides the retry action", async () => {
  writeFileSync(join(dir, ".git/index.lock"), "Another writer"); await post(); rmSync(join(dir, ".git/index.lock"));
  await runWithRequestContext({ adapter: base, uploadHandler: { async upload() { return { url: "/unused" }; } }, sessionId: null, demoMode: false,
    authorize: async action => action !== "publish" }, async () => {
    expect(await (await state()).json()).toMatchObject({ journalPending: 1, retryJournal: false });
    expect((await post({ retryJournal: true })).status).toBe(403);
    expect((await post()).status).toBe(403);
  });
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
});

it("keeps receipts outside a requested collection and rejects mixed retry commands", async () => {
  writeFileSync(join(dir, ".git/index.lock"), "Another writer"); await post(); rmSync(join(dir, ".git/index.lock"));
  expect(await (await post({ retryJournal: true, collection: "pages" })).json()).toMatchObject({ journal: { pending: 0, completed: 0 } });
  expect(await (await raw()).listGitJournalReceipts!()).toHaveLength(1);
  expect((await post({ retryJournal: true, retryRebuild: true })).status).toBe(400);
  expect(git("rev-list", "--count", "HEAD")).toBe("1");
});
