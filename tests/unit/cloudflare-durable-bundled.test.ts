import { beforeEach, expect, it, vi } from "vitest";
import { MemoryDurableNamespace } from "../helpers/storage-fakes";
const state = vi.hoisted(() => ({ namespace: null as MemoryDurableNamespace | null,
  modules: {} as Record<string, Record<string, unknown>> }));
vi.mock("../../packages/cloudflare/src/runtime/env.js", () => ({ getCloudflareRuntimeEnv: async () => ({ CMS_CONTENT: state.namespace }) }));
vi.mock("../../packages/cloudflare/src/runtime/bundled-data.js", () => ({ getDataModules: () => state.modules }));
import { CloudflareDurableStorageAdapter } from "../../packages/cloudflare/src/adapters/durable-storage";
function adapter() { return new CloudflareDurableStorageAdapter(); }
const meta = { id: "seeded", label: "Seeded", created_at: 1, updated_at: 1, schema: { type: "object" as const, properties: {} } };
beforeEach(() => { state.namespace = new MemoryDurableNamespace(); state.modules = { "/.caret/data/seeded/one.json": { title: "Seeded" } }; });

it("reads initial bundled data and keeps deletion intent after explicit collection recreation", async () => {
  const base = adapter();
  expect((await base.getEntry("seeded", "one"))?.data.title).toBe("Seeded");
  await base.createCollection(meta); await base.deleteCollection("seeded"); await base.createCollection(meta);
  const restarted = adapter();
  expect(await restarted.getEntry("seeded", "one")).toBeNull();
  expect(await restarted.listEntryIds("seeded")).toEqual([]);
  expect((await restarted.getEntrySnapshot("seeded", "one")).entry).toBeNull();
  state.modules["/.caret/data/seeded/new-build.json"] = { title: "New build seed" };
  expect(await restarted.getEntry("seeded", "new-build")).toBeNull();
  expect(await restarted.listEntryIds("seeded")).toEqual([]);
});

it("rejects a stale seed-existence precondition after collection recreation", async () => {
  const base = adapter();
  await base.createCollection(meta); await base.deleteCollection("seeded"); await base.createCollection(meta);
  expect(await base.commitEntries([{ collection: "seeded", id: "one", expectedRevision: await base.getRevision("seeded", "one"), expectedExists: true, data: { title: "Stale" } }]))
    .toMatchObject({ ok: false, conflict: { exists: false } });
  expect(await base.getEntry("seeded", "one")).toBeNull();
});

it("invalidates a seeded entry's old revision even when it never had a stored record", async () => {
  const base = adapter();
  expect(await base.getEntrySnapshot("seeded", "one")).toEqual({ entry: { id: "one", data: { title: "Seeded" } }, revision: 0 });
  await base.deleteCollection("seeded");
  expect(await base.getEntrySnapshot("seeded", "one")).toEqual({ entry: null, revision: 1 });
  expect(await base.commitEntries([{ collection: "seeded", id: "one", expectedRevision: 0, expectedExists: false, data: { title: "Stale recreation" } }]))
    .toMatchObject({ ok: false, conflict: { currentRevision: 1, exists: false } });
});

it("allows new content without exposing the rest of a removed seed collection", async () => {
  const base = adapter();
  await base.createCollection(meta); await base.deleteCollection("seeded");
  expect((await base.commitEntries([{ collection: "seeded", id: "fresh", expectedRevision: 0, expectedExists: false, data: { title: "Fresh" } }])).ok).toBe(true);
  expect((await base.getEntry("seeded", "fresh"))?.data.title).toBe("Fresh");
  expect(await base.listEntryIds("seeded")).toEqual(["fresh"]);
  expect(await base.getEntry("seeded", "one")).toBeNull();
});

it.each(["explicit", "implicit"])("retains legacy deletion markers during %s recreation", async mode => {
  state.namespace!.get("default");
  await state.namespace!.stores.get("default")!.put("deleted-collections", ["seeded"]);
  const base = adapter();
  if (mode === "explicit") await base.createCollection(meta);
  else await base.writeEntry("seeded", "fresh", { title: "Fresh" });
  expect(await base.getEntry("seeded", "one")).toBeNull();
  expect(await base.listEntryIds("seeded")).toEqual(mode === "explicit" ? [] : ["fresh"]);
  expect((await base.getEntrySnapshot("seeded", "one")).entry).toBeNull();
});
