import { expect, it } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { runStorageConformance } from "../../packages/core/src/testing/storage-conformance";
import type { StorageAdapter } from "../../packages/core/src/types";

it("isolates failures, disposes every fixture, and reports unsupported checks", async () => {
  let disposed = 0;
  const results = await runStorageConformance(async name => {
    const adapter = new InMemoryAdapter();
    if (name === "missing entry") await adapter.writeEntry("caret-conformance", "entry", { title: "Not empty" });
    return { adapter, dispose: async () => { disposed++; } };
  });
  expect(results.filter(result => result.status === "failed")).toEqual([
    { name: "missing entry", status: "failed", message: "Fresh fixture is not empty" },
  ]);
  expect(results.find(result => result.name === "entry clone isolation")?.status).toBe("passed");
  expect(results.filter(result => result.status === "skipped").map(result => result.name))
    .toEqual(["batch snapshot alignment", "transactional batch preflight", "independent conditional commits", "transactional snapshot coherence"]);
  expect(disposed).toBe(results.length);
});

it("reports cleanup errors without silently certifying the fixture", async () => {
  const results = await runStorageConformance(async () => ({ adapter: new InMemoryAdapter(),
    dispose: async () => { throw new Error("Cleanup failed"); } }));
  expect(results.every(result => result.status === "failed" && result.message?.includes("Cleanup failed"))).toBe(true);
});

it("rejects transactional claims without the required primitives", async () => {
  const results = await runStorageConformance(async () => {
    const original = new InMemoryAdapter();
    const adapter = new Proxy(original, { get(target, key) {
      if (key === "guarantees") return { ...target.guarantees, commits: "transactional", snapshots: "transactional" };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as StorageAdapter;
    return { adapter };
  });
  expect(results.find(result => result.name === "declared methods"))
    .toMatchObject({ status: "failed", message: "Transactional commits require commitEntries" });
});
