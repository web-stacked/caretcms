import { beforeEach, expect, it, vi } from "vitest";
import { MemoryDurableNamespace } from "../helpers/storage-fakes";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { publishOverlay } from "../../packages/core/src/runtime/publish";
import { SessionOverlayAdapter } from "../../packages/core/src/runtime/storage/session-overlay-adapter";

const control = vi.hoisted(() => ({ namespace: null as MemoryDurableNamespace | null,
  beforeDraftCommit: null as (() => Promise<void>) | null, modules: {} as Record<string, Record<string, unknown>> }));
vi.mock("../../packages/cloudflare/src/runtime/env.js", () => ({ getCloudflareRuntimeEnv: async () => ({
  CMS_CONTENT: {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({ fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as { type: string };
      if (control.beforeDraftCommit && (command.type === "commit_draft_entries" ||
          (command.type === "commit_entries" && String(id).includes(":draft:")))) {
        const task = control.beforeDraftCommit; control.beforeDraftCommit = null; await task();
      }
      return control.namespace!.get(id).fetch(input, init);
    } }),
  },
}) }));
vi.mock("../../packages/cloudflare/src/runtime/bundled-data.js", () => ({ getDataModules: () => control.modules }));
import { CloudflareDurableStorageAdapter } from "../../packages/cloudflare/src/adapters/durable-storage";
import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY } from "../../packages/core/src/runtime/draft-state";

const base = (instanceName = "site") => new CloudflareDurableStorageAdapter({ instanceName,
  bundledFallback: false, editorDrafts: "coordinated" });
const change = (id = "one", revision = 0) => ({ collection: "posts", id, expectedRevision: revision,
  expectedBaseRevision: 1, requireBaseRevision: true, expectedExists: true,
  data: { title: "Private draft" }, history: { ts: 1, action: "put", data: null } });
beforeEach(() => { control.namespace = new MemoryDurableNamespace(); control.beforeDraftCommit = null; control.modules = {}; });

it("atomically rejects a base change between first-draft preparation and commit", async () => {
  const published = base();
  await published.commitEntries([{ ...change(), expectedRevision: 0, expectedExists: false, data: { title: "Original" } }]);
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  control.beforeDraftCommit = async () => {
    expect((await base().commitEntries([{ ...change(), expectedRevision: 1, data: { title: "Other writer" } }])).ok).toBe(true);
  };
  expect(await draft.commitEntries([change()])).toMatchObject({ ok: false,
    conflict: { id: "one", currentRevision: 0, currentBaseRevision: 2 } });
  expect(control.beforeDraftCommit).toBeNull();
  expect(await raw.getEntry("posts", "one")).toBeNull();
  expect(await raw.getRevision("posts", "one")).toBe(0);
  expect(await raw.getHistory("posts", "one")).toEqual([]);
});

it("rejects an entire draft batch when a later entry's published baseline changes", async () => {
  const published = base();
  await published.commitEntries(["one", "two"].map(id => ({ ...change(id), expectedExists: false, data: { title: id } })));
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  control.beforeDraftCommit = async () => {
    await base().commitEntries([{ ...change("two", 1), data: { title: "Other writer" } }]);
  };
  expect(await draft.commitEntries([change("one"), change("two")])).toMatchObject({ ok: false,
    conflict: { id: "two", currentBaseRevision: 2 } });
  for (const id of ["one", "two"]) {
    expect(await raw.getEntry("posts", id)).toBeNull();
    expect(await raw.getRevision("posts", id)).toBe(0);
    expect(await raw.getHistory("posts", id)).toEqual([]);
  }
});

it("keeps durable draft content, versions, indexes, history and receipts private to an editor and tenant", async () => {
  const published = base();
  const alice = await published.makeEditorOverlay("alice");
  const bob = await published.makeEditorOverlay("bob");
  const other = await base("other").makeEditorOverlay("alice");
  expect((await alice.commitEntries!([{ ...change(), expectedExists: false }])).ok).toBe(true);
  await alice.createCollection!({ id: "private", label: "Private", schema: {}, created_at: 1, updated_at: 1 });
  await alice.setRebuildReceipt!({ published: [], commit: null });
  for (const store of [published, bob, other]) {
    expect(await store.getEntry("posts", "one")).toBeNull();
    expect(await store.getRevision("posts", "one")).toBe(0);
    expect(await store.getHistory("posts", "one")).toEqual([]);
    expect(await store.discoverCollections()).toEqual([]);
    expect(await store.getCollectionMetadata!("private")).toBeNull();
    expect(await store.getRebuildReceipt!()).toBeNull();
  }
  expect(await alice.listEntryIds("posts")).toEqual(["one"]);
  expect(await alice.getRevision("posts", "one")).toBe(1);
  expect(await alice.getHistory("posts", "one")).toHaveLength(1);
  expect(control.namespace!.stores.size).toBe(2);
  await alice.deleteCollection!("posts");
  expect(await alice.getEntry("posts", "one")).toBeNull();
  expect(await alice.getRevision("posts", "one")).toBe(2);
  expect(await published.getRevision("posts", "one")).toBe(0);
});

it("returns coherent ordered paired snapshots including duplicates, missing and deleted entries", async () => {
  const published = base();
  await published.commitEntries([ { ...change(), expectedExists: false, data: { title: "Base" } } ]);
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  expect(draft.guarantees).toMatchObject({ snapshots: "transactional", commits: "transactional" });
  expect(await draft.commitEntries([change()])).toMatchObject({ ok: true });
  const pairs = await raw.coordinateDrafts!(published)!.getEntrySnapshots("posts", ["one", "missing", "one"]);
  expect(pairs[0].base).toEqual({ entry: { id: "one", data: { title: "Base" } }, revision: 1 });
  expect(pairs[0].overlay.revision).toBe(1);
  expect(pairs[1]).toEqual({ base: { entry: null, revision: 0 }, overlay: { entry: null, revision: 0 } });
  expect(pairs[2]).toEqual(pairs[0]);
  expect(await draft.getEntrySnapshots("posts", [])).toEqual([]);
  expect((await draft.getEntrySnapshot("posts", "one")).entry?.data).toEqual({ title: "Private draft" });
  expect((await draft.getEntrySnapshot("posts", "missing"))).toEqual({ entry: null, revision: 0, baseRevision: 0 });
  expect(await draft.commitEntries([{ ...change("one", 1), data: null }])).toMatchObject({ ok: true });
  expect(await draft.getEntrySnapshot("posts", "one")).toEqual({ entry: null, revision: 2 });
  expect((await published.getEntry("posts", "one"))?.data.title).toBe("Base");
});

it("protects missing-entry creation against a concurrently created base entry", async () => {
  const published = base();
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  control.beforeDraftCommit = async () => {
    await base().commitEntries([{ ...change(), expectedExists: false }]);
  };
  expect(await draft.commitEntries([{ ...change(), expectedBaseRevision: 0, expectedExists: false }])).toMatchObject({
    ok: false, conflict: { currentBaseRevision: 1, currentRevision: 0 } });
  expect(await raw.getEntry("posts", "one")).toBeNull();
});

it("protects a draft deletion against a base edit made after preparation", async () => {
  const published = base();
  await published.commitEntries([{ ...change(), expectedExists: false }]);
  const raw = await published.makeEditorOverlay("alice");
  control.beforeDraftCommit = async () => { await base().commitEntries([{ ...change("one", 1) }]); };
  expect(await new SessionOverlayAdapter(published, raw).commitEntries([{ ...change(), data: null }])).toMatchObject({
    ok: false, conflict: { currentBaseRevision: 2 } });
  expect(await raw.getEntry("posts", "one")).toBeNull();
});

it("protects first body drafts and body-to-structured conversion while retaining a body delta", async () => {
  const published = base();
  await published.commitEntries([{ ...change(), expectedExists: false, data: { title: "Base" } }]);
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  control.beforeDraftCommit = async () => { await base().commitEntries([{ ...change("one", 1), data: { title: "Latest" } }]); };
  const body = { ...change(), data: { __body: [] }, writeMode: "body" as const };
  expect(await draft.commitEntries([body])).toMatchObject({ ok: false, conflict: { currentBaseRevision: 2 } });
  expect(await draft.commitEntries([body])).toMatchObject({ ok: true });
  expect((await draft.getEntrySnapshot("posts", "one"))).toMatchObject({ revision: 1, baseRevision: 2,
    entry: { data: { title: "Latest", __body: [] } } });
  control.beforeDraftCommit = async () => { await base().commitEntries([{ ...change("one", 2), data: { title: "Newest" } }]); };
  expect(await draft.commitEntries([{ ...change("one", 1), expectedBaseRevision: 2 }])).toMatchObject({
    ok: false, conflict: { currentRevision: 1, currentBaseRevision: 3 } });
  expect((await raw.getEntry("posts", "one"))?.data[DRAFT_STATE_KEY]).toMatchObject({ baseRevision: 2, structured: false });
  expect((await draft.getEntry("posts", "one"))?.data).toEqual({ title: "Newest", __body: [] });
});

it("preserves a structured draft's original publication baseline across later edits", async () => {
  const published = base();
  await published.commitEntries([{ ...change(), expectedExists: false, data: { title: "Original" } }]);
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  await draft.commitEntries([change()]);
  control.beforeDraftCommit = async () => { await base().commitEntries([{ ...change("one", 1), data: { title: "Other" } }]); };
  expect(await draft.commitEntries([{ ...change("one", 1), data: { title: "Draft 2" } }])).toMatchObject({ ok: true });
  expect((await raw.getEntry("posts", "one"))?.data[DRAFT_STATE_KEY]).toMatchObject({ baseRevision: 1,
    baseData: { title: "Original" }, structured: true });
  expect((await draft.getEntry("posts", "one"))?.data).toEqual({ title: "Draft 2" });
});

it("rejects stale own revisions without changing any entry in a batch", async () => {
  const published = base();
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  const create = { ...change(), expectedBaseRevision: 0, expectedExists: false };
  await draft.commitEntries([create]);
  expect(await draft.commitEntries([{ ...create, id: "two" }, create])).toMatchObject({ ok: false,
    conflict: { id: "one", currentRevision: 1 } });
  expect(await raw.getEntry("posts", "two")).toBeNull();
  expect(await raw.getRevision("posts", "two")).toBe(0);
  expect(await raw.getHistory("posts", "two")).toEqual([]);
  expect(await raw.getHistory("posts", "one")).toHaveLength(1);
});

it("keeps legacy separate objects as the default and declines unsupported coordination pairs", async () => {
  const legacy = new CloudflareDurableStorageAdapter({ bundledFallback: false });
  const raw = await legacy.makeEditorOverlay("alice");
  expect(raw.coordinateDrafts!(legacy)).toBeUndefined();
  expect(new SessionOverlayAdapter(legacy, raw).guarantees?.commits).toBe("process");
  await raw.writeEntry("posts", "one", { title: "Legacy" });
  expect(control.namespace!.stores.has("default:draft:alice")).toBe(true);
  const published = base();
  const coordinated = await published.makeEditorOverlay("alice");
  expect(coordinated.coordinateDrafts!(base("other"))).toBeUndefined();
  expect(coordinated.coordinateDrafts!(coordinated)).toBeUndefined();
  expect((await published.makeSessionOverlay("visitor")).coordinateDrafts!(published)).toBeUndefined();
  expect(new SessionOverlayAdapter(published, coordinated, false).guarantees?.commits).toBe("process");
  expect(() => new CloudflareDurableStorageAdapter({ editorDrafts: "coordinated" }, 10)).toThrow("durable");
  await expect(published.makeEditorOverlay("../bad")).rejects.toThrow("Invalid editor id");
});

it("fails closed when an older object does not recognize the scoped envelope", async () => {
  const published = base();
  const raw = await published.makeEditorOverlay("alice");
  const get = control.namespace!.get.bind(control.namespace);
  control.namespace!.get = id => ({ fetch: async (input, init) => {
    if (JSON.parse(String(init?.body)).type === "editor_command") return Response.json({ error: "Unknown command" }, { status: 400 });
    return get(id).fetch(input, init);
  } });
  await expect(raw.writeEntry("posts", "one", { title: "Private" })).rejects.toThrow("Unknown command");
  expect(await published.getEntry("posts", "one")).toBeNull();
});

it("captures bundled baselines without exposing bundled entries in the private realm", async () => {
  control.modules["/.caret/data/posts/one.json"] = { title: "Seed" };
  const published = new CloudflareDurableStorageAdapter({ instanceName: "seed", editorDrafts: "coordinated" });
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  expect(await raw.getEntry("posts", "one")).toBeNull();
  expect(await draft.getEntrySnapshot("posts", "one")).toMatchObject({ baseRevision: 0, entry: { data: { title: "Seed" } } });
  control.beforeDraftCommit = async () => {
    await published.commitEntries([{ ...change(), data: { title: "Changed seed" } }]);
  };
  expect(await draft.commitEntries([{ ...change(), expectedBaseRevision: 0 }])).toMatchObject({ ok: false,
    conflict: { currentBaseRevision: 1 } });
  await published.deleteCollection("posts");
  expect(await draft.getEntrySnapshot("posts", "one")).toEqual({ entry: null, revision: 0, baseRevision: 2 });
  expect(await raw.getEntry("posts", "one")).toBeNull();
});

it("compares draft versions again in the transaction after preparation", async () => {
  const published = base();
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  control.beforeDraftCommit = async () => {
    await raw.commitEntries!([{ ...change(), expectedExists: false, data: { title: "Other draft writer" } }]);
  };
  expect(await draft.commitEntries([{ ...change(), expectedBaseRevision: 0, expectedExists: false }])).toMatchObject({
    ok: false, conflict: { currentRevision: 1 } });
  expect((await raw.getEntry("posts", "one"))?.data.title).toBe("Other draft writer");
  expect(await raw.getHistory("posts", "one")).toHaveLength(1);
});

it("blocks edits while a private publication recovery record is pending", async () => {
  const published = base();
  const raw = await published.makeEditorOverlay("alice");
  await raw.writeEntry("posts", "one", { title: "Pending", [PUBLISH_RECOVERY_KEY]: { version: 1 } });
  await expect(new SessionOverlayAdapter(published, raw).commitEntries([{ ...change(), expectedBaseRevision: 0 }]))
    .rejects.toThrow("Finish pending publication");
  expect((await raw.getEntry("posts", "one"))?.data.title).toBe("Pending");
  expect(await published.getEntry("posts", "one")).toBeNull();
});

it("rejects scoped expiry, invalid editor IDs and recursive envelopes without touching shared content", async () => {
  const published = base();
  await published.writeEntry("posts", "one", { title: "Published" });
  const store = control.namespace!.stores.get("site")!;
  const alarm = vi.spyOn(store, "setAlarm");
  const send = (command: unknown, ttl?: number) => control.namespace!.get("site").fetch("https://storage.test", {
    method: "POST", headers: { "content-type": "application/json", ...(ttl ? { "x-caret-ttl-seconds": String(ttl) } : {}) },
    body: JSON.stringify(command),
  });
  for (const type of ["editor_command", "get_draft_snapshots", "commit_draft_entries"]) {
    expect((await send({ type, editorId: "alice" }, 2)).status).toBe(400);
  }
  expect(alarm).not.toHaveBeenCalled();
  expect((await send({ type: "editor_command", editorId: "alice", command: {
    type: "editor_command", editorId: "bob", command: { type: "delete_collection", collection: "posts" },
  } })).status).toBe(400);
  expect((await send({ type: "editor_command", editorId: "../bad", command: { type: "delete_collection", collection: "posts" } })).ok).toBe(false);
  expect((await published.getEntry("posts", "one"))?.data.title).toBe("Published");
});

it("cannot overwrite a publication recovery record written after preparation without a revision bump", async () => {
  const published = base();
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  await draft.commitEntries([{ ...change(), expectedBaseRevision: 0, expectedExists: false }]);
  control.beforeDraftCommit = async () => {
    const existing = (await raw.getEntry("posts", "one"))!;
    await raw.writeEntry("posts", "one", { ...existing.data, [PUBLISH_RECOVERY_KEY]: { version: 1 } });
  };
  expect(await draft.commitEntries([{ ...change("one", 1), data: { title: "Raced edit" } }])).toMatchObject({
    ok: false, conflict: { currentRevision: 1 } });
  expect((await raw.getEntry("posts", "one"))?.data[PUBLISH_RECOVERY_KEY]).toEqual({ version: 1 });
  expect(await raw.getHistory("posts", "one")).toHaveLength(1);
});

it("publishes an engine-created coordinated draft and cleans up only that editor's realm", async () => {
  const published = base();
  await published.commitEntries([{ ...change(), expectedExists: false, data: { title: "Original" } }]);
  const alice = await published.makeEditorOverlay("alice");
  const bob = await published.makeEditorOverlay("bob");
  const draft = new SessionOverlayAdapter(published, alice);
  expect(await executeMutation(draft, { type: "put_entry", collection: "posts", id: "one",
    data: { title: "Approved" }, expectedRevision: 0, expectedBaseRevision: 1 })).toMatchObject({ ok: true });
  await bob.writeEntry("posts", "one", { title: "Bob draft" });
  const result = await publishOverlay(published, alice);
  expect(result.published).toHaveLength(1);
  expect(result.failed).toEqual([]);
  expect(result.conflicts).toEqual([]);
  expect((await published.getEntry("posts", "one"))?.data).toEqual({ title: "Approved" });
  expect(await published.getRevision("posts", "one")).toBe(2);
  expect(await alice.getEntry("posts", "one")).toBeNull();
  expect((await bob.getEntry("posts", "one"))?.data).toEqual({ title: "Bob draft" });
});

it("retains a coordinated structured draft when publication discovers a newer base version", async () => {
  const published = base();
  await published.commitEntries([{ ...change(), expectedExists: false }]);
  const raw = await published.makeEditorOverlay("alice");
  const draft = new SessionOverlayAdapter(published, raw);
  await draft.commitEntries([change()]);
  await base().commitEntries([{ ...change("one", 1), data: { title: "Other writer" } }]);
  const result = await publishOverlay(published, raw);
  expect(result.published).toEqual([]);
  expect(result.conflicts).toHaveLength(1);
  expect((await raw.getEntry("posts", "one"))?.data.title).toBe("Private draft");
  expect((await published.getEntry("posts", "one"))?.data.title).toBe("Other writer");
});

it("preserves parent isolation when an editor overlay creates nested session or editor overlays", async () => {
  const published = base();
  const alice = await published.makeEditorOverlay("alice");
  const bob = await published.makeEditorOverlay("bob");
  for (const factory of ["makeSessionOverlay", "makeEditorOverlay"] as const) {
    const nested = await alice[factory]!("shared");
    await nested.writeEntry("posts", "one", { title: "Nested Alice" });
    for (const parent of [published, bob]) {
      const other = await parent[factory]!("shared");
      expect(await other.getEntry("posts", "one")).toBeNull();
    }
    expect((await nested.getEntry("posts", "one"))?.data.title).toBe("Nested Alice");
    expect(nested.coordinateDrafts!(published)).toBeUndefined();
  }
});
