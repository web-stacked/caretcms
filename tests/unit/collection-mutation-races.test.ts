import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryAdapter } from "../../packages/core/src/runtime/storage/in-memory-adapter";
import { executeMutation } from "../../packages/core/src/runtime/mutations/engine";
import { readEntrySnapshot } from "../../packages/core/src/runtime/storage/read-snapshot";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const put = (id: string, revision: number) => ({ type: "put_entry", collection: "race", id, data: { title: "Changed" }, expectedRevision: revision });
async function fixture() {
  const base = new InMemoryAdapter();
  expect((await executeMutation(base, put("one", 0))).ok).toBe(true);
  return base;
}
afterEach(() => vi.restoreAllMocks());

describe("collection management and entry operations", () => {
  it("finishes an in-flight entry write before deleting its collection", async () => {
    const base = await fixture(), entered = gate(), finish = gate();
    const original = base.writeEntry.bind(base);
    vi.spyOn(base, "writeEntry").mockImplementationOnce(async (...args) => {
      entered.release(); await finish.promise; await original(...args);
    });
    const deleting = vi.spyOn(base, "deleteCollection");
    const saved = executeMutation(base, put("one", 1));
    await entered.promise;
    const removed = executeMutation(base, { type: "delete_collection", id: "race" });
    try {
      await tick();
      expect(deleting).not.toHaveBeenCalled();
    } finally { finish.release(); await Promise.allSettled([saved, removed]); }
    expect((await saved).ok).toBe(true);
    expect((await removed).ok).toBe(true);
    expect(await base.getEntry("race", "one")).toBeNull();
    expect(await base.isKnownCollection("race")).toBe(false);
    expect(await base.getRevision("race", "one")).toBe(3);
  });

  it("rejects an old entry write queued behind collection deletion", async () => {
    const base = await fixture(), entered = gate(), finish = gate();
    const original = base.deleteCollection.bind(base);
    vi.spyOn(base, "deleteCollection").mockImplementationOnce(async (...args) => {
      entered.release(); await finish.promise; await original(...args);
    });
    const writing = vi.spyOn(base, "writeEntry");
    const removed = executeMutation(base, { type: "delete_collection", id: "race" });
    await entered.promise;
    const saved = executeMutation(base, put("one", 1));
    try {
      await tick();
      expect(writing).not.toHaveBeenCalled();
    } finally { finish.release(); await Promise.allSettled([saved, removed]); }
    expect((await removed).ok).toBe(true);
    expect(await saved).toMatchObject({ ok: false, status: 409, body: { currentRevision: 2 } });
    expect(await base.getEntry("race", "one")).toBeNull();
  });

  it("keeps different entry writes concurrent within a collection", async () => {
    const base = await fixture(), finish = gate(), bothEntered = gate();
    const original = base.writeEntry.bind(base);
    let count = 0;
    vi.spyOn(base, "writeEntry").mockImplementation(async (...args) => {
      if (++count === 2) bothEntered.release();
      await finish.promise; await original(...args);
    });
    const writes = [executeMutation(base, put("one", 1)), executeMutation(base, put("two", 0))];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const entered = await Promise.race([bothEntered.promise.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
      expect(entered).toBe(true);
    } finally { clearTimeout(timer); finish.release(); await Promise.allSettled(writes); }
    expect((await Promise.all(writes)).every(result => result.ok)).toBe(true);
  });

  it("finishes an entry snapshot before collection removal", async () => {
    const base = await fixture(), entered = gate(), finish = gate();
    const original = base.getEntry.bind(base);
    vi.spyOn(base, "getEntry").mockImplementationOnce(async (...args) => {
      const entry = await original(...args); entered.release(); await finish.promise; return entry;
    });
    const deleting = vi.spyOn(base, "deleteCollection");
    const read = readEntrySnapshot(base, "race", "one");
    await entered.promise;
    const removed = executeMutation(base, { type: "delete_collection", id: "race" });
    try { await tick(); expect(deleting).not.toHaveBeenCalled(); }
    finally { finish.release(); await Promise.allSettled([read, removed]); }
    expect(await read).toEqual({ entry: { id: "one", data: { title: "Changed" } }, revision: 1 });
    expect((await removed).ok).toBe(true);
    expect(await readEntrySnapshot(base, "race", "one")).toEqual({ entry: null, revision: 2 });
  });

  it("releases the collection barrier after an adapter throws", async () => {
    const base = await fixture();
    vi.spyOn(base, "writeEntry").mockRejectedValueOnce(new Error("Storage failure"));
    await expect(executeMutation(base, put("one", 1))).rejects.toThrow("Storage failure");
    expect((await executeMutation(base, { type: "delete_collection", id: "race" })).ok).toBe(true);
    expect(await base.getEntry("race", "one")).toBeNull();
  });
});
