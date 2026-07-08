/**
 * Draft publish / discard — flush a per-editor draft overlay into the base store
 * (or throw it away). The overlay is built by `StorageAdapter.makeEditorOverlay`;
 * the base is the shared published store. Each entry is moved under the SAME
 * per-entry lock the mutation engine uses, so a publish serializes against any
 * concurrent save on that entry instead of tearing the data/revision pair.
 */
import type { StorageAdapter } from "../types.js";
import { withEntryLock } from "./mutations/engine.js";
import { TOMBSTONE_KEY } from "./storage/session-overlay-adapter.js";

export interface PublishScope {
  /** Limit to one collection (with `id`, to one entry). Omit to publish all. */
  collection?: string;
  /** Limit to one entry; only honored together with `collection`. */
  id?: string;
}

export interface PublishedEntry {
  collection: string;
  id: string;
  /** New base revision after the flush (0 for a deleted entry). */
  revision: number;
  deleted: boolean;
}

function isTombstoneData(data: Record<string, unknown> | undefined): boolean {
  return Boolean(data && data[TOMBSTONE_KEY] === true);
}

/** The (collection, id) pairs that currently exist in the overlay within scope. */
async function overlayEntriesInScope(
  overlay: StorageAdapter,
  scope: PublishScope,
): Promise<Array<{ collection: string; id: string }>> {
  const collections = scope.collection
    ? [scope.collection]
    : await overlay.discoverCollections();
  const out: Array<{ collection: string; id: string }> = [];
  for (const collection of collections) {
    const ids =
      scope.collection && scope.id
        ? [scope.id]
        : await overlay.listEntryIds(collection);
    for (const id of ids) out.push({ collection, id });
  }
  return out;
}

/**
 * Flush the overlay into the base. A tombstoned draft entry deletes from the
 * base; any other draft entry is written, the base revision bumped, and a
 * `"publish"` history entry (carrying the pre-publish base data) appended. Each
 * published entry is then cleared from the overlay so it stops shadowing the
 * base. Returns the new base revisions so the client can reconcile its cached
 * revision map — without this, the first edit after a publish would 409.
 *
 * NOT atomic across multiple entries (per-entry locks only): on a partial
 * failure the returned list reflects exactly what was committed. Callers that
 * surface "publish all" should report that list.
 */
export async function publishOverlay(
  base: StorageAdapter,
  overlay: StorageAdapter,
  scope: PublishScope = {},
): Promise<PublishedEntry[]> {
  const targets = await overlayEntriesInScope(overlay, scope);
  const published: PublishedEntry[] = [];

  for (const { collection, id } of targets) {
    const result = await withEntryLock(collection, id, async (): Promise<PublishedEntry | null> => {
      const draft = await overlay.getEntry(collection, id);
      if (!draft) return null; // raced away; nothing to publish

      if (isTombstoneData(draft.data)) {
        await base.deleteEntry(collection, id);
        await overlay.deleteEntry(collection, id);
        // Contract: a deleted entry reports revision 0. `deleteEntry` doesn't
        // necessarily clear the revision counter (filesystem keeps it for ABA
        // safety), so getRevision would return a stale non-zero value — return 0
        // explicitly to match PublishedEntry's documented meaning.
        return { collection, id, revision: 0, deleted: true };
      }

      const before = await base.getEntry(collection, id);
      await base.writeEntry(collection, id, draft.data);
      const revision = await base.bumpRevision(collection, id);
      await base.appendHistory(collection, id, {
        ts: Date.now(),
        action: "publish",
        data: before?.data ?? null,
      });
      await overlay.deleteEntry(collection, id);
      return { collection, id, revision, deleted: false };
    });
    if (result) published.push(result);
  }

  return published;
}

/** Count draft entries currently held in an editor overlay. */
export async function countOverlayDrafts(
  overlay: StorageAdapter,
  scope: PublishScope = {},
): Promise<number> {
  return (await overlayEntriesInScope(overlay, scope)).length;
}

/** Discard an editor's draft(s) within scope without touching the base. Returns
 *  the number of overlay entries cleared. */
export async function discardOverlay(
  overlay: StorageAdapter,
  scope: PublishScope = {},
): Promise<number> {
  const targets = await overlayEntriesInScope(overlay, scope);
  for (const { collection, id } of targets) {
    await withEntryLock(collection, id, () => overlay.deleteEntry(collection, id));
  }
  return targets.length;
}
