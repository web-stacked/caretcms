import type { StorageAdapter, EntrySnapshot } from "../../types.js";
import { withEntryLock, withEntryLocks } from "../mutations/engine.js";

/** The fallback coordinates with CMS writes in this process, not external writers. */
export function readEntrySnapshot(adapter: StorageAdapter, collection: string, id: string): Promise<EntrySnapshot> {
  return withEntryLock(collection, id, () => readAdapterSnapshot(adapter, collection, id));
}

/** Internal composition: caller already holds the CMS lock; never acquire it recursively. */
export async function readAdapterSnapshot(adapter: StorageAdapter, collection: string, id: string): Promise<EntrySnapshot> {
  if (adapter.getEntrySnapshot) return adapter.getEntrySnapshot(collection, id);
  const entry = await adapter.getEntry(collection, id);
  const revision = await adapter.getRevision(collection, id);
  return { entry, revision };
}

export function readEntrySnapshots(adapter: StorageAdapter, collection: string, ids: readonly string[]): Promise<EntrySnapshot[]> {
  const wanted = [...ids];
  return withEntryLocks(wanted.map(id => ({ collection, id })), () => readAdapterSnapshots(adapter, collection, wanted));
}

/** Caller already holds every entry lock; batch order/cardinality are part of the contract. */
export async function readAdapterSnapshots(adapter: StorageAdapter, collection: string, ids: readonly string[]): Promise<EntrySnapshot[]> {
  if (!ids.length) return [];
  if (!adapter.getEntrySnapshots) return Promise.all(ids.map(id => readAdapterSnapshot(adapter, collection, id)));
  const snapshots = await adapter.getEntrySnapshots(collection, ids);
  if (!Array.isArray(snapshots) || snapshots.length !== ids.length || snapshots.some((snapshot, index) =>
    !snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
    (snapshot.entry !== null && (!snapshot.entry || snapshot.entry.id !== ids[index])) ||
    (snapshot.baseRevision !== undefined && (!Number.isSafeInteger(snapshot.baseRevision) || snapshot.baseRevision < 0)))) {
    throw new Error("Invalid adapter batch snapshots");
  }
  return snapshots;
}
