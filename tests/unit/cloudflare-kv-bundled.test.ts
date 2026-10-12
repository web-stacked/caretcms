import { beforeEach, expect, it, vi } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("../../packages/cloudflare/src/runtime/env.js", () => ({
  getCloudflareRuntimeEnv: async () => ({ CMS_KV: {
    get: async (key: string) => store.has(key) ? JSON.parse(store.get(key)!) : null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  } }),
}));
vi.mock("../../packages/cloudflare/src/runtime/bundled-data.js", () => ({
  getDataModules: () => ({
    "/.caret/data/seeded/one.json": { title: "One" },
    "/.caret/data/seeded/two.json": { title: "Two" },
  }),
}));
import { CloudflareKvStorageAdapter } from "../../packages/cloudflare/src/adapters/kv-storage";
beforeEach(() => { store.clear(); });

it("keeps deleted bundled entries absent and permits explicit recreation", async () => {
  const storage = new CloudflareKvStorageAdapter();
  expect((await storage.getEntry("seeded", "one"))?.data.title).toBe("One");
  await storage.deleteEntry("seeded", "one");
  expect(await storage.getEntry("seeded", "one")).toBeNull();
  expect(await storage.listEntryIds("seeded")).toEqual(["two"]);
  await storage.writeEntry("seeded", "one", { title: "Recreated" });
  expect((await storage.getEntry("seeded", "one"))?.data.title).toBe("Recreated");
  expect(await storage.listEntryIds("seeded")).toEqual(["one", "two"]);
});

it("keeps deleted bundled collections absent without reviving their entries on recreation", async () => {
  const storage = new CloudflareKvStorageAdapter();
  expect(await storage.discoverCollections()).toEqual(["seeded"]);
  await storage.deleteCollection("seeded");
  expect(await storage.discoverCollections()).toEqual([]);
  expect(await storage.listEntryIds("seeded")).toEqual([]);
  expect(await storage.getEntry("seeded", "one")).toBeNull();
  await storage.createCollection({ id: "seeded", label: "Recreated", schema: {}, created_at: 1, updated_at: 1 });
  expect(await storage.discoverCollections()).toEqual(["seeded"]);
  expect(await storage.listEntryIds("seeded")).toEqual([]);
  expect(await storage.getEntry("seeded", "one")).toBeNull();
  await storage.writeEntry("seeded", "one", { title: "New" });
  expect(await storage.listEntryIds("seeded")).toEqual(["one"]);
  expect(await storage.getEntry("seeded", "two")).toBeNull();
});


it("reserves deletion metadata keys without colliding with valid collection entries", async () => {
  const storage = new CloudflareKvStorageAdapter();
  await storage.writeEntry("deleted-collection", "seeded", { title: "User content" });
  await storage.writeEntry("bundled-disabled", "seeded", { title: "More user content" });
  await storage.deleteCollection("seeded");
  expect((await storage.getEntry("deleted-collection", "seeded"))?.data.title).toBe("User content");
  expect((await storage.getEntry("bundled-disabled", "seeded"))?.data.title).toBe("More user content");
});
