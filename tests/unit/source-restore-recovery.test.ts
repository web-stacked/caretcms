import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownAdapter } from "../../packages/core/src/runtime/storage/markdown-adapter";
import { onRequest } from "../../packages/core/src/runtime/middleware";
import { POST as restore } from "../../packages/core/src/runtime/routes/history";
import { getEditorId, issueEditorSessionCookie } from "../../packages/core/src/runtime/auth/session";
import { __setRuntimeServicesForTests } from "../../packages/core/src/runtime/providers";
import { PUBLISH_RECOVERY_KEY } from "../../packages/core/src/runtime/draft-state";
import { registerCollectionSchema } from "../../packages/core/src/runtime/schema-registry";

const roots: string[] = [];
const original = "---\ntitle: Current\n---\nCurrent body\n";
const historical = "---\ntitle: Historical\n---\nHistorical body\n";
afterEach(async () => { vi.restoreAllMocks(); __setRuntimeServicesForTests(null); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function session() {
  const token = decodeURIComponent(issueEditorSessionCookie().split(";")[0].split("=")[1]);
  return { get(name: string) { return name === "caret_session" ? { value: token } : undefined; } };
}
async function fixture(collection = "posts") {
  const root = await mkdtemp(join(tmpdir(), "caret-restore-recovery-")); roots.push(root);
  const options = { contentRoot: join(root, "content"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") };
  await mkdir(join(options.contentRoot, collection), { recursive: true });
  const path = join(options.contentRoot, collection, "one.md");
  await writeFile(path, original);
  const base = new MarkdownAdapter(options);
  await base.appendHistory(collection, "one", { ts: 123, action: "publish", data: { title: "Historical" }, bodySource: historical });
  const cookies = session(); const editorId = getEditorId({ cookies })!;
  return { root, options, path, base, cookies, editorId, collection };
}
async function request(f: Awaited<ReturnType<typeof fixture>>, ts = 123) {
  __setRuntimeServicesForTests({ adapter: f.base, uploadHandler: { async upload() { return { url: "/unused" }; } } });
  const url = new URL("http://localhost/api/cms/history");
  const context = { cookies: f.cookies, url, locals: {}, request: new Request(url, { method: "POST", headers: { "x-caret-request": "1" }, body: JSON.stringify({ collection: f.collection, id: "one", ts }) }) };
  return onRequest(context, () => restore(context as never));
}

describe("source-backed history restore recovery", () => {
  it.each(["writeBodySource", "bumpRevision", "appendHistory"] as const)("recovers %s failures before and after persistence across adapter restarts", async method => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const after of [false, true]) {
      const f = await fixture();
      const originalMethod = f.base[method].bind(f.base) as (...args: unknown[]) => Promise<unknown>;
      const spy = vi.spyOn(f.base, method).mockImplementationOnce(async (...args: unknown[]) => {
        if (after) await originalMethod(...args);
        throw new Error("storage outage");
      });
      expect((await request(f)).status).toBe(500);
      const recovery = await f.base.makeRecoveryOverlay(f.editorId, "source-restore");
      expect((await recovery.getEntry(f.collection, "one"))?.data[PUBLISH_RECOVERY_KEY]).toBeDefined();
      spy.mockRestore();
      f.base = new MarkdownAdapter(f.options);
      const response = await request(f);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ revision: 1, data: { title: "Historical" } });
      expect(await readFile(f.path, "utf8")).toBe(historical);
      expect(await f.base.getRevision(f.collection, "one")).toBe(1);
      const history = await f.base.getHistory(f.collection, "one");
      expect(history.filter(entry => entry.action === "restore")).toHaveLength(1);
      expect(history[0]).toMatchObject({ action: "restore", data: { title: "Current" }, bodySource: original });
      expect(await recovery.getEntry(f.collection, "one")).toBeNull();
      // A retry after successful cleanup is a no-op for the exact same source.
      expect((await request(f)).status).toBe(200);
      expect(await f.base.getRevision(f.collection, "one")).toBe(1);
      expect((await f.base.getHistory(f.collection, "one")).filter(entry => entry.action === "restore")).toHaveLength(1);
    }
  });

  it("recovers cleanup even when recording restore history trims the requested snapshot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    for (let ts = 124; ts < 173; ts++) await f.base.appendHistory(f.collection, "one", { ts, action: "save_field", data: { title: "Other" } });
    const recovery = await f.base.makeRecoveryOverlay(f.editorId, "source-restore");
    vi.spyOn(recovery, "deleteEntry").mockRejectedValueOnce(new Error("cleanup outage"));
    f.base.makeRecoveryOverlay = async () => recovery;
    expect((await request(f)).status).toBe(500);
    expect((await f.base.getHistory(f.collection, "one")).some(entry => entry.ts === 123)).toBe(false);
    f.base = new MarkdownAdapter(f.options);
    expect((await request(f)).status).toBe(200);
    expect(await recovery.getEntry(f.collection, "one")).toBeNull();
    expect(await f.base.getRevision(f.collection, "one")).toBe(1);
    expect((await f.base.getHistory(f.collection, "one")).filter(entry => entry.action === "restore")).toHaveLength(1);
  });

  it("preserves a newer external source instead of overwriting it during recovery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    vi.spyOn(f.base, "bumpRevision").mockRejectedValueOnce(new Error("revision outage"));
    expect((await request(f)).status).toBe(500);
    const external = "---\ntitle: External\n---\nLater body\n";
    await writeFile(f.path, external);
    f.base = new MarkdownAdapter(f.options);
    expect((await request(f)).status).toBe(409);
    expect(await readFile(f.path, "utf8")).toBe(external);
    expect((await (await f.base.makeRecoveryOverlay(f.editorId, "source-restore")).getEntry(f.collection, "one"))?.data[PUBLISH_RECOVERY_KEY]).toBeDefined();
  });

  it("rejects a different target while a restore is pending and isolates recovery from drafts and other editors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    vi.spyOn(f.base, "writeBodySource").mockRejectedValueOnce(new Error("source outage"));
    expect((await request(f)).status).toBe(500);
    expect((await request(f, 124)).status).toBe(409);
    expect(await readFile(f.path, "utf8")).toBe(original);
    expect(await (await f.base.makeEditorOverlay(f.editorId)).listEntryIds(f.collection)).toEqual([]);
    expect(await (await f.base.makeRecoveryOverlay("other-editor", "source-restore")).listEntryIds(f.collection)).toEqual([]);
  });

  it.each([false, true])("enforces a changed schema before writing, but finishes an already applied restore (applied: %s)", async applied => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture(`restore-schema-${applied}`);
    const method = applied ? "bumpRevision" : "writeBodySource";
    vi.spyOn(f.base, method).mockRejectedValueOnce(new Error("outage"));
    expect((await request(f)).status).toBe(500);
    f.base = new MarkdownAdapter(f.options);
    registerCollectionSchema(f.collection, { type: "object", required: ["newField"] }, null);
    expect((await request(f)).status).toBe(applied ? 200 : 400);
    expect(await readFile(f.path, "utf8")).toBe(applied ? historical : original);
    expect(await f.base.getRevision(f.collection, "one")).toBe(applied ? 1 : 0);
  });

  it("does not touch the source if persisting the recovery plan fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture();
    const recovery = await f.base.makeRecoveryOverlay(f.editorId, "source-restore");
    vi.spyOn(recovery, "writeEntry").mockRejectedValueOnce(new Error("disk full"));
    f.base.makeRecoveryOverlay = async () => recovery;
    expect((await request(f)).status).toBe(500);
    expect(await readFile(f.path, "utf8")).toBe(original);
    expect(await f.base.getRevision(f.collection, "one")).toBe(0);
    expect(await f.base.getHistory(f.collection, "one")).toHaveLength(1);
  });
});

it("refuses source replacement without a durable recovery store", async () => {
  const f = await fixture();
  Object.defineProperty(f.base, "makeRecoveryOverlay", { value: undefined });
  const response = await request(f);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("recovery storage");
  expect(await readFile(f.path, "utf8")).toBe(original);
  expect(await f.base.getRevision(f.collection, "one")).toBe(0);
});
