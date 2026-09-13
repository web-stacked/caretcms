import { canPerform, PermissionDenied } from "./authorization.js";
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
import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY, readDraftState, sameContent } from "./draft-state.js";
import { prepareSource, recoveryState, resumePublish, RecoveryConflict, type PublishRecovery } from "./publish-recovery.js";
import { getRequestContext } from "./request-context.js";
import { commitEntryChanges } from "./storage/entry-commit.js";

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
  /** Body hashes, structured baselines, or legacy drafts failed validation.
   * The entry was not published and its draft is preserved. */
  reason: "stale_body" | "invalid_body" | "stale_entry" | "legacy_draft";
}

export interface PublishOutcome {
  published: PublishedEntry[];
  conflicts: PublishConflict[];
  failed: Array<{ collection: string; id: string; reason: "storage_error" | "recovery_conflict" }>;
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

/** Preflight the entire batch before any source, revision, journal or hook write. */
export async function canPublishOverlay(overlay: StorageAdapter, scope: PublishScope = {}): Promise<boolean> {
  if (!getRequestContext()?.authorize) return true;
  const targets = await overlayEntriesInScope(overlay, scope);
  if (!targets.length) return canPerform("publish", scope.collection, scope.id);
  for (const { collection, id } of targets) {
    if (!(await canPerform("publish", collection, id))) return false;
    const draft = await overlay.getEntry(collection, id);
    const plan = draft ? recoveryState(draft.data) : null;
    if ((isTombstoneData(draft?.data) || plan?.afterData === null) && !(await canPerform("delete", collection, id))) return false;
  }
  return true;
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
  if (!(await canPublishOverlay(overlay, scope))) throw new PermissionDenied();
  const targets = await overlayEntriesInScope(overlay, scope);
  const published: PublishedEntry[] = [];
  const conflicts: PublishConflict[] = [];
  const failed: PublishOutcome["failed"] = [];
  for (const { collection, id } of targets) {
    try {
      await withEntryLock(collection, id, async () => {
        const draftRevision = await overlay.getRevision(collection, id);
        const draft = await overlay.getEntry(collection, id);
        if (!draft) return;
        let plan = recoveryState(draft.data);
        if (!plan) {
          const state = readDraftState(draft.data);
          const { [BODY_OVERLAY_KEY]: _body, [DRAFT_STATE_KEY]: _state,
            [PUBLISH_RECOVERY_KEY]: _recovery, [TOMBSTONE_KEY]: _tombstone, ...fields } = draft.data;
          const blocks = extractBodyBlocks(draft.data);
          if (blocks === undefined) {
            conflicts.push({ collection, id, reason: "invalid_body" });
            return;
          }
          const deleted = isTombstoneData(draft.data);
          const structured = state?.structured ?? (deleted || Object.keys(fields).length > 0);
          if (!state && structured) {
            conflicts.push({ collection, id, reason: "legacy_draft" });
            return;
          }
          const before = (await base.getEntry(collection, id))?.data ?? null;
          const beforeRevision = await base.getRevision(collection, id);
          if (structured && state && (state.baseRevision !== beforeRevision || !sameContent(state.baseData, before))) {
            conflicts.push({ collection, id, reason: "stale_entry" });
            return;
          }
          const after = deleted ? null : structured ? fields : { ...(before ?? {}), ...fields };
          const source = base.readBodySource ? await base.readBodySource(collection, id) : null;
          if (blocks?.length && (!source || !base.writeBodySource)) {
            conflicts.push({ collection, id, reason: "invalid_body" });
            return;
          }
          const afterSource = source !== null && after !== null && base.writeBodySource
            ? prepareSource(source, before, after, blocks ?? []) : undefined;
          if (afterSource === null) {
            conflicts.push({ collection, id, reason: "stale_body" });
            return;
          }
          const context = getRequestContext();
          const editor = context?.identity ?? (context?.editorId ? { id: context.editorId } : null);
          plan = {
            version: 1, beforeRevision, beforeData: before, afterData: after,
            ...(source !== null ? { beforeSource: source } : {}),
            ...(afterSource !== undefined ? { afterSource } : {}),
            history: { operationId: crypto.randomUUID(), ts: Date.now(), action: "publish", data: before,
              ...(source !== null ? { bodySource: source } : {}), ...(editor ? { editor } : {}) },
          };
          const persisted = await commitEntryChanges(overlay, [{
            collection,
            id,
            expectedRevision: draftRevision,
            expectedExists: true,
            data: { ...draft.data, [PUBLISH_RECOVERY_KEY]: plan },
          }]);
          if (!persisted.ok) {
            conflicts.push({ collection, id, reason: "stale_entry" });
            return;
          }
        }
        const revision = await resumePublish(base, overlay, collection, id, plan);
        published.push({ collection, id, revision, deleted: plan.afterData === null });
      });
    } catch (error) {
      console.error("[caretcms] Publish requires recovery:", error);
      failed.push({ collection, id, reason: error instanceof RecoveryConflict ? "recovery_conflict" : "storage_error" });
    }
  }
  return { published, conflicts, failed };
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
    await withEntryLock(collection, id, async () => {
      const revision = await overlay.getRevision(collection, id);
      const draft = await overlay.getEntry(collection, id);
      if (draft?.data[PUBLISH_RECOVERY_KEY]) throw new Error("Finish pending publication before discarding drafts");
      if (draft) {
        const discarded = await commitEntryChanges(overlay, [{
          collection, id, expectedRevision: revision, expectedExists: true, data: null,
        }]);
        if (!discarded.ok) throw new Error("Draft changed while it was being discarded");
      }
    });
  }
  return targets.length;
}
