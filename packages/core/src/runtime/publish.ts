/**
 * Draft publish / discard — flush a per-editor draft overlay into the base store
 * (or throw it away). The overlay is built by `StorageAdapter.makeEditorOverlay`;
 * the base is the shared published store. Each entry is moved under the SAME
 * per-entry lock the mutation engine uses, so a publish serializes against any
 * concurrent save on that entry instead of tearing the data/revision pair.
 */
import type { StorageAdapter } from "../types.js";
import { BODY_OVERLAY_KEY, parseMdSrc, formatMdSrc, type MdSrc } from "../markdown/contracts.js";
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

export interface PublishConflict {
  collection: string;
  id: string;
  /** `stale_body` = the source file changed since the body draft was made;
   *  `invalid_body` = the draft's body map is corrupt or the adapter can't
   *  splice. The entry was NOT published and its draft is preserved. */
  reason: "stale_body" | "invalid_body";
}

export interface PublishOutcome {
  published: PublishedEntry[];
  conflicts: PublishConflict[];
}

/** Extract + validate the body-draft map from draft data, or null when absent.
 *  `undefined` return = present but malformed (never publish through it). */
function extractBodyBlocks(
  data: Record<string, unknown>,
): Array<{ md: string; src: MdSrc }> | null | undefined {
  const raw = data[BODY_OVERLAY_KEY];
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const blocks: Array<{ md: string; src: MdSrc }> = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") return undefined;
    const { md, src } = value as { md?: unknown; src?: unknown };
    if (typeof md !== "string" || md.includes("\u0000")) return undefined;
    if (src === null || typeof src !== "object") return undefined;
    const { start, end, hash } = src as { start?: unknown; end?: unknown; hash?: unknown };
    // Round-trip through the contract parser so only well-formed hints pass.
    const parsed =
      typeof start === "number" && typeof end === "number" && typeof hash === "string"
        ? parseMdSrc(formatMdSrc({ start, end, hash }))
        : null;
    if (!parsed) return undefined;
    blocks.push({ md, src: parsed });
  }
  return blocks;
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
): Promise<PublishOutcome> {
  const targets = await overlayEntriesInScope(overlay, scope);
  const published: PublishedEntry[] = [];
  const conflicts: PublishConflict[] = [];

  for (const { collection, id } of targets) {
    const result = await withEntryLock(
      collection,
      id,
      async (): Promise<PublishedEntry | PublishConflict | null> => {
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

        // Body drafts ride the entry under the reserved key. They are flushed
        // as source-file splices and MUST NOT reach writeEntry — the markdown
        // adapter would serialize them into frontmatter.
        const bodyBlocks = extractBodyBlocks(draft.data);
        if (bodyBlocks === undefined) return { collection, id, reason: "invalid_body" };
        const { [BODY_OVERLAY_KEY]: _drafts, ...entryData } = draft.data;

        // Splice FIRST, all-or-nothing: a stale block aborts the whole entry
        // (frontmatter included) with the draft preserved, so a publish can
        // never land half of an entry's edits.
        let bodySource: string | undefined;
        if (bodyBlocks && bodyBlocks.length > 0) {
          if (!base.spliceBodyBlocks || !base.readBodySource) {
            return { collection, id, reason: "invalid_body" };
          }
          bodySource = (await base.readBodySource(collection, id)) ?? undefined;
          const spliced = await base.spliceBodyBlocks(collection, id, bodyBlocks);
          if (!spliced.ok) {
            return { collection, id, reason: "stale_body" };
          }
        }

        const before = await base.getEntry(collection, id);
        // Merge the draft's frontmatter DELTAS onto the current base rather than
        // replacing it. A body-only draft carries no frontmatter keys, so base
        // fields edited after the draft was staged (e.g. a Studio field save,
        // which writes straight to base in server delivery) survive instead of
        // being clobbered by a stale snapshot. Skip the write entirely when the
        // merge changes nothing — a body-only publish must not re-serialize
        // untouched frontmatter (it re-quotes scalars and pollutes the diff).
        // Same-shape objects come through the same parse path, so stringify
        // comparison is order-stable here.
        const mergedData = { ...(before?.data ?? {}), ...entryData };
        if (JSON.stringify(before?.data ?? null) !== JSON.stringify(mergedData)) {
          await base.writeEntry(collection, id, mergedData);
        }
        const revision = await base.bumpRevision(collection, id);
        await base.appendHistory(collection, id, {
          ts: Date.now(),
          action: "publish",
          data: before?.data ?? null,
          // Pre-publish source file, so a restore can put the prose back.
          ...(bodySource !== undefined ? { bodySource } : {}),
        });
        await overlay.deleteEntry(collection, id);
        return { collection, id, revision, deleted: false };
      },
    );
    if (result && "reason" in result) conflicts.push(result);
    else if (result) published.push(result);
  }

  return { published, conflicts };
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
