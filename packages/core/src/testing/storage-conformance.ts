import type { StorageAdapter, EntryCommit, HistoryEntry, CollectionMetadata } from "../types.js";

export interface StorageConformanceFixture {
  /** A fresh, empty, private store. Never use production content. */
  adapter: StorageAdapter;
  /** Another client for the same store; enables concurrent transaction checks. */
  reopen?(): Promise<StorageAdapter>;
  /** Wait for single-writer visibility on eventually consistent stores. */
  settle?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface StorageConformanceResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  message?: string;
}

type Check = (fixture: StorageConformanceFixture) => Promise<void>;
const collection = "caret-conformance";
const id = "entry";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
  assert(JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected)), message);
}
const metadata = (): CollectionMetadata => ({ id: collection, label: "Conformance", created_at: 1, updated_at: 1,
  schema: { type: "object", properties: { title: { type: "string" } } } });
const history = (ts: number): HistoryEntry => ({ ts, action: "save", data: { title: `Version ${ts}` }, editor: { id: "alice" } });
const settle = async (f: StorageConformanceFixture) => { await f.settle?.(); };

/**
 * Destructive behavioral checks for a fresh adapter fixture per test. No test
 * framework dependency. Skips are explicit and do not certify untested claims.
 * Fault injection, restart durability, expiry, and real platform isolation need
 * additional provider-specific tests.
 */
export async function runStorageConformance(
  createFixture: (name: string) => Promise<StorageConformanceFixture>,
): Promise<StorageConformanceResult[]> {
  const results: StorageConformanceResult[] = [];
  async function check(name: string, task: Check, requires?: (f: StorageConformanceFixture) => string | null) {
    let fixture: StorageConformanceFixture | undefined;
    let result: StorageConformanceResult;
    try {
      fixture = await createFixture(name);
      const reason = requires?.(fixture);
      if (reason) result = { name, status: "skipped", message: reason };
      else { await task(fixture); result = { name, status: "passed" }; }
    } catch (error) {
      result = { name, status: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      if (fixture?.dispose) {
        try { await fixture.dispose(); }
        catch (error) { result = { name, status: "failed", message: `Fixture cleanup failed: ${String(error)}` }; }
      }
    }
    results.push(result!);
  }

  await check("declared methods", async ({ adapter: a }) => {
    if (a.guarantees?.commits === "transactional") assert(a.commitEntries, "Transactional commits require commitEntries");
    if (a.guarantees?.snapshots === "transactional") assert(a.getEntrySnapshot, "Transactional snapshots require getEntrySnapshot");
    assert(Boolean(a.getRebuildReceipt) === Boolean(a.setRebuildReceipt), "Rebuild receipt methods must be paired");
    assert(Boolean(a.getDeploymentTarget) === Boolean(a.setDeploymentTarget), "Deployment target methods must be paired");
    assert(!a.writeBodySource || a.readBodySource, "Source writes require source reads");
  });
  await check("missing entry", async ({ adapter: a }) => {
    equal(await a.getEntry(collection, id), null, "Fresh fixture is not empty");
    equal(await a.getRevision(collection, id), 0, "Fresh fixture has a nonzero revision");
    equal(await a.getHistory(collection, id), [], "Fresh fixture has history");
  });
  await check("entry clone isolation", async f => {
    const a = f.adapter, input = { title: "Original", nested: { items: ["one"] } };
    await a.writeEntry(collection, id, input); await settle(f);
    input.nested.items[0] = "Changed input";
    const read = await a.getEntry(collection, id);
    equal(read, { id, data: { title: "Original", nested: { items: ["one"] } } }, "Stored data aliases input");
    (read!.data.nested as typeof input.nested).items[0] = "Changed read";
    equal((await a.getEntry(collection, id))?.data.nested, { items: ["one"] }, "Stored data aliases reads");
  });
  await check("entry indexes", async f => {
    const a = f.adapter;
    for (const entryId of ["b", "a"]) { await a.writeEntry(collection, entryId, { title: entryId }); await settle(f); }
    equal(await a.listEntryIds(collection), ["a", "b"], "Entry IDs are not sorted or complete");
    assert((await a.discoverCollections()).includes(collection), "Written collection is not discoverable");
    await a.deleteEntry(collection, "a"); await settle(f);
    equal(await a.listEntryIds(collection), ["b"], "Deleted entry remains indexed");
    equal(await a.listEntries(collection), [{ id: "b", data: { title: "b" } }], "Listed entries disagree with IDs");
    equal(await a.getEntry(collection, "a"), null, "Deleted entry remains visible");
  });
  await check("entry revision lifetime", async f => {
    const a = f.adapter;
    await a.writeEntry(collection, id, { title: "Original" }); await settle(f);
    equal(await a.bumpRevision(collection, id), 1, "First revision is incorrect"); await settle(f);
    await a.deleteEntry(collection, id); await settle(f);
    equal(await a.bumpRevision(collection, id), 2, "Deletion reset the revision"); await settle(f);
    await a.writeEntry(collection, id, { title: "Recreated" }); await settle(f);
    equal(await a.bumpRevision(collection, id), 3, "Recreation reused an old revision"); await settle(f);
    equal(await a.getRevision(collection, id), 3, "Stored revision differs from acknowledgement");
  });
  await check("history clone isolation", async f => {
    const a = f.adapter, first = history(1);
    await a.appendHistory(collection, id, first); await settle(f);
    (first.data as { title: string }).title = "Changed input";
    await a.appendHistory(collection, id, history(2)); await settle(f);
    const read = await a.getHistory(collection, id);
    equal(read, [history(2), history(1)], "History order or input isolation is incorrect");
    (read[0].data as { title: string }).title = "Changed read";
    equal(await a.getHistory(collection, id), [history(2), history(1)], "History aliases returned data");
  });
  await check("collection metadata clone isolation", async f => {
    const a = f.adapter, input = metadata();
    await a.createCollection(input); await settle(f);
    input.label = "Changed input";
    (input.schema.properties.title as { type: string }).type = "number";
    equal(await a.getCollectionMetadata(collection), metadata(), "Metadata aliases input");
    const read = await a.getCollectionMetadata(collection);
    read!.label = "Changed read";
    (read!.schema.properties.title as { type: string }).type = "number";
    equal(await a.getCollectionMetadata(collection), metadata(), "Metadata aliases reads");
    assert((await a.listCollectionMetadata()).some(meta => meta.id === collection), "Metadata is not listed");
  });
  await check("collection revision lifetime", async f => {
    const a = f.adapter;
    await a.createCollection(metadata()); await settle(f);
    await a.writeEntry(collection, id, { title: "Original" }); await settle(f);
    const originalRevision = await a.bumpRevision(collection, id); await settle(f);
    await a.deleteCollection(collection); await settle(f);
    equal(await a.getCollectionMetadata(collection), null, "Deleted metadata remains visible");
    if (a.guarantees!.collectionDeletion === "metadata") {
      equal((await a.getEntry(collection, id))?.data, { title: "Original" }, "Source collection deletion removed project content");
      equal(await a.getRevision(collection, id), originalRevision, "Metadata-only deletion changed the content revision");
      return;
    }
    equal(await a.getEntry(collection, id), null, "Collection deletion retained content");
    assert(await a.getRevision(collection, id) > originalRevision, "Collection deletion did not invalidate the old revision");
    await a.createCollection(metadata()); await settle(f);
    await a.writeEntry(collection, id, { title: "Recreated" }); await settle(f);
    assert(await a.bumpRevision(collection, id) > originalRevision, "Recreated entry reused the old revision");
  }, f => f.adapter.guarantees ? null : "Collection deletion semantics are unspecified");
  await check("editor overlay isolation", async f => {
    const a = f.adapter, alice = await a.makeEditorOverlay!("alice"), bob = await a.makeEditorOverlay!("bob");
    await alice.writeEntry(collection, id, { title: "Private" }); await settle(f);
    equal(await a.getEntry(collection, id), null, "Overlay writes changed base");
    equal(await bob.getEntry(collection, id), null, "Overlay writes changed another editor");
    equal((await (await a.makeEditorOverlay!("alice")).getEntry(collection, id))?.data, { title: "Private" }, "Same editor did not reopen the draft store");
  }, f => f.adapter.makeEditorOverlay ? null : "Editor overlays are not provided");
  await check("rebuild receipt round trip", async f => {
    const a = f.adapter, receipt = { published: [{ collection, id, revision: 1, deleted: false }], commit: null };
    await a.setRebuildReceipt!(receipt); await settle(f);
    equal(await a.getRebuildReceipt!(), receipt, "Receipt changed on read");
    await a.setRebuildReceipt!(null); await settle(f);
    equal(await a.getRebuildReceipt!(), null, "Receipt did not clear");
  }, f => f.adapter.getRebuildReceipt && f.adapter.setRebuildReceipt ? null : "Receipt methods are not provided");

  await check("batch snapshot alignment", async f => {
    const a = f.adapter;
    for (const entryId of ["a", "b"]) {
      await a.writeEntry(collection, entryId, { title: entryId }); await settle(f);
      await a.bumpRevision(collection, entryId); await settle(f);
    }
    await a.bumpRevision(collection, "b"); await settle(f);
    equal(await a.getEntrySnapshots!(collection, ["b", "missing", "a", "b"]), [
      { entry: { id: "b", data: { title: "b" } }, revision: 2 }, { entry: null, revision: 0 },
      { entry: { id: "a", data: { title: "a" } }, revision: 1 }, { entry: { id: "b", data: { title: "b" } }, revision: 2 },
    ], "Batch snapshots lost order, missing IDs, duplicates, or versions");
    equal(await a.getEntrySnapshots!(collection, []), [], "Empty batch is not empty");
  }, f => f.adapter.getEntrySnapshots ? null : "Batch snapshots are not provided");

  const transactional = (f: StorageConformanceFixture) => f.adapter.guarantees?.commits === "transactional"
    ? f.adapter.commitEntries ? null : "Transactional method is missing" : "Transactional batch commits are not declared";
  const change = (entryId: string, title: string, revision: number, exists: boolean): EntryCommit => ({
    collection, id: entryId, expectedRevision: revision, expectedExists: exists, data: { title }, history: history(revision + 1),
  });
  await check("transactional batch preflight", async ({ adapter: a }) => {
    assert((await a.commitEntries!([change("a", "Original A", 0, false), change("b", "Original B", 0, false)])).ok, "Initial commit failed");
    const result = await a.commitEntries!([change("a", "Changed A", 1, true), change("b", "Changed B", 0, true)]);
    assert(!result.ok && result.conflict.id === "b", "Stale batch did not report its conflict");
    for (const entryId of ["a", "b"]) {
      equal((await a.getEntry(collection, entryId))?.data.title, `Original ${entryId.toUpperCase()}`, "Stale batch partially wrote data");
      equal(await a.getRevision(collection, entryId), 1, "Stale batch partially advanced revision");
      equal(await a.getHistory(collection, entryId), [history(1)], "Stale batch partially changed history");
    }
    equal(await a.listEntryIds(collection), ["a", "b"], "Stale batch changed indexes");
  }, transactional);
  await check("independent conditional commits", async f => {
    const second = await f.reopen!();
    const results = await Promise.all([
      f.adapter.commitEntries!([change(id, "First", 0, false)]),
      second.commitEntries!([change(id, "Second", 0, false)]),
    ]);
    assert(results.filter(result => result.ok).length === 1, "Independent clients both won or both failed");
    equal((await f.adapter.getEntry(collection, id))?.data.title, results[0].ok ? "First" : "Second", "Winning commit did not store its data");
    equal(await f.adapter.getRevision(collection, id), 1, "Concurrent commits advanced revision twice");
    equal(await f.adapter.getHistory(collection, id), [history(1)], "Concurrent commits recorded duplicate history");
  }, f => transactional(f) ?? (f.reopen ? null : "Independent client fixture is not provided"));
  await check("transactional snapshot coherence", async f => {
    const second = await f.reopen!();
    const writer = async () => {
      for (let revision = 0; revision < 10; revision++) {
        assert((await f.adapter.commitEntries!([change(id, String(revision + 1), revision, revision > 0)])).ok, "Snapshot test commit failed");
      }
      assert((await f.adapter.commitEntries!([{ ...change(id, "", 10, true), data: null }])).ok, "Snapshot test deletion failed");
    };
    const reader = async () => {
      for (let count = 0; count < 20; count++) {
        const snapshot = await second.getEntrySnapshot!(collection, id);
        assert(snapshot.entry ? Number(snapshot.entry.data.title) === snapshot.revision : [0, 11].includes(snapshot.revision), "Snapshot mixed content and revision");
      }
    };
    await Promise.all([writer(), reader()]);
    equal(await second.getEntrySnapshot!(collection, id), { entry: null, revision: 11 }, "Deleted snapshot lost its revision");
  }, f => transactional(f) ?? (f.adapter.guarantees?.snapshots !== "transactional" ? "Transactional snapshots are not declared"
    : !f.adapter.getEntrySnapshot ? "Snapshot method is missing" : f.reopen ? null : "Independent client fixture is not provided"));
  return results;
}
