import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemAdapter } from "../../packages/core/src/runtime/storage/filesystem-adapter";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";
import { SidecarMetaStore } from "../../packages/core/src/runtime/storage/sidecar-meta-store";
import { readEntrySnapshots } from "../../packages/core/src/runtime/storage/read-snapshot";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { runWithRequestContext } from "../../packages/core/src/runtime/request-context";
import { GET as entries } from "../../packages/core/src/runtime/routes/entries";
import type { StorageAdapter, EntrySnapshot } from "../../packages/core/src/types";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "caret-batch-")); roots.push(root);
  const base = new FilesystemAdapter({ dataRoot: join(root, "data"), metaRoot: join(root, "meta"), draftsRoot: join(root, "drafts") });
  for (const id of ["a", "b", "c"]) {
    expect((await executeMutation(base, { type: "put_entry", collection: "batch", id, data: { title: `Alpha ${id}` }, expectedRevision: 0 })).ok).toBe(true);
  }
  return { root, base };
}
function route(adapter: StorageAdapter, query = "") {
  const url = new URL(`http://localhost/api/cms/entries?collection=batch${query}`);
  return runWithRequestContext({ adapter, uploadHandler: { upload: async () => ({ url: "" }) }, sessionId: null, demoMode: false,
    editor: true, identity: { id: "alice" } }, () => entries({ request: new Request(url), url, cookies: { get: () => undefined } } as any));
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

it("reads one shared revision map and preserves missing/deleted/duplicate IDs", async () => {
  const { base } = await fixture();
  await executeMutation(base, { type: "delete_entry", collection: "batch", id: "c", expectedRevision: 1 });
  const single = vi.spyOn(SidecarMetaStore.prototype, "getRevision"), bulk = vi.spyOn(SidecarMetaStore.prototype, "getRevisions");
  const snapshots = await readEntrySnapshots(base, "batch", ["b", "missing", "c", "a", "b"]);
  expect(snapshots.map(snapshot => [snapshot.entry?.id ?? null, snapshot.revision]))
    .toEqual([["b", 1], [null, 0], [null, 2], ["a", 1], ["b", 1]]);
  expect(bulk).toHaveBeenCalledTimes(1);
  expect(single).not.toHaveBeenCalled();
});

it.each([true, false])("preserves individual overlay semantics with draft tracking %s", async track => {
  const base = new InMemoryAdapter(), raw = await base.makeEditorOverlay("alice");
  const wrapper = new SessionOverlayAdapter(base, raw, track);
  for (const id of ["structured", "body", "base", "deleted"]) { await base.writeEntry("batch", id, { title: "Original", remove: "Old" }); await base.bumpRevision("batch", id); }
  await wrapper.writeEntry("batch", "structured", { title: "Draft" }); await wrapper.bumpRevision("batch", "structured");
  await wrapper.writeBodyDraft("batch", "body", { __body: {} }); await wrapper.bumpRevision("batch", "body");
  await wrapper.deleteEntry("batch", "deleted"); await wrapper.bumpRevision("batch", "deleted");
  await base.writeEntry("batch", "body", { title: "Later" }); await base.bumpRevision("batch", "body");
  const ids = ["structured", "body", "base", "deleted", "missing", "body"];
  expect(await readEntrySnapshots(wrapper, "batch", ids)).toEqual(await Promise.all(ids.map(id => wrapper.getEntrySnapshot("batch", id))));
});

it("uses batches for search and serves the cached page without rereading", async () => {
  const { base } = await fixture();
  const bulk = vi.spyOn(base, "getEntrySnapshots"), single = vi.spyOn(base, "getRevision");
  const response = await route(base, "&q=alpha&pageSize=2");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries.map((entry: any) => [entry.id, entry.revision])).toEqual([["a", 1], ["b", 1]]);
  expect(body.pagination.total).toBe(3);
  expect(bulk).toHaveBeenCalledTimes(1);
  expect(single).not.toHaveBeenCalled();
});

it("isolates corrupt content through the existing per-entry fallback", async () => {
  const { root, base } = await fixture();
  await mkdir(join(root, "data/batch"), { recursive: true });
  await writeFile(join(root, "data/batch/b.json"), "invalid json");
  const response = await route(base);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries).toHaveLength(3);
  expect(body.entries.find((entry: any) => entry.id === "b").readError.code).toBe("invalid_content");
  expect(body.entries.find((entry: any) => entry.id === "a").data.title).toBe("Alpha a");
});

describe("invalid optional batch implementations", () => {
  it.each(["short", "wrong-id", "negative"])("falls back safely for %s snapshots", async kind => {
    const { base } = await fixture();
    vi.spyOn(base, "getEntrySnapshots").mockResolvedValue(kind === "short" ? [] : [
      { entry: { id: kind === "wrong-id" ? "other" : "a", data: { title: "Untrusted batch" } }, revision: kind === "negative" ? -1 : 1 },
      { entry: null, revision: 1 }, { entry: null, revision: 1 },
    ]);
    const response = await route(base);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries.map((entry: any) => entry.data.title)).toEqual(["Alpha a", "Alpha b", "Alpha c"]);
  });
});

it("holds every batch entry lock through content/version reads", async () => {
  const { base } = await fixture(), entered = gate(), finish = gate();
  const original = base.getEntrySnapshots.bind(base);
  vi.spyOn(base, "getEntrySnapshots").mockImplementationOnce(async (...args) => { entered.release(); await finish.promise; return original(...args); });
  const writing = vi.spyOn(base, "writeEntry");
  const read = readEntrySnapshots(base, "batch", ["a", "b"]);
  await entered.promise;
  const saved = executeMutation(base, { type: "put_entry", collection: "batch", id: "b", data: { title: "Later" }, expectedRevision: 1 });
  try { await new Promise<void>(resolve => setImmediate(resolve)); expect(writing).not.toHaveBeenCalled(); }
  finally { finish.release(); await Promise.allSettled([read, saved]); }
  expect((await read).map((snapshot: EntrySnapshot) => [snapshot.entry?.data.title, snapshot.revision])).toEqual([["Alpha a", 1], ["Alpha b", 1]]);
  expect((await saved).ok).toBe(true);
});
