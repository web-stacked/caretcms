import { validateEntryTransition, EntryValidationError } from "./entry-validation.js";
import { readAdapterSnapshot } from "./storage/read-snapshot.js";
import { canPerform, PermissionDenied } from "./authorization.js";
/**
 * Draft publish / discard — flush a per-editor draft overlay into the base store
 * (or throw it away). The overlay is built by `StorageAdapter.makeEditorOverlay`;
 * the base is the shared published store. Each entry is moved under the SAME
 * per-entry lock the mutation engine uses, so a publish serializes against any
 * concurrent save on that entry instead of tearing the data/revision pair.
 */
import type { StorageAdapter, PublicationSourceSnapshot, GitJournalTarget } from "../types.js";
import { BODY_OVERLAY_KEY, parseMdSrc, formatMdSrc, type MdSrc } from "../markdown/contracts.js";
import { withEntryLock } from "./mutations/engine.js";
import { SessionOverlayAdapter, TOMBSTONE_KEY } from "./storage/session-overlay-adapter.js";
import { draftChange } from "./unpublished.js";
import { loadPageContent } from "./page-content.js";
import { trackTemplateText } from "./template-text.js";
import { DRAFT_STATE_KEY, PUBLISH_RECOVERY_KEY, contentFingerprint, isStaleDraft, readDraftState, rebaseDraft } from "./draft-state.js";
import { prepareSource, recoveryState, validPublicationSources, resumePublish, RecoveryConflict, type PublishRecovery } from "./publish-recovery.js";
import { getRequestContext } from "./request-context.js";
import { commitEntryChanges } from "./storage/entry-commit.js";
import { canonicalBody } from "../markdown/canonical-body.js";

export interface PublishScope {
  /** Limit to one collection (with `id`, to one entry). Omit to publish all. */
  collection?: string;
  /** Limit to one entry; only honored together with `collection`. */
  id?: string;
  /** Limit to these entries (within `collection`/`id` when those are given too). */
  entries?: ReadonlyArray<{ collection: string; id: string }>;
}

export interface PublishOptions {
  /** Explicit opt-in; captured in the recovery plan before applying content. */
  journal?: { target: GitJournalTarget; authorName: string; authorEmail: string };
  /**
   * Asked for each entry about to be written. True holds the entry back with
   * `uncommitted_source`: its source file has changes of someone else's that
   * a commit of this publish would sweep in.
   */
  holdUncommitted?: (collection: string, id: string, deleted: boolean) => Promise<boolean>;
}

export interface PublishedEntry {
  collection: string;
  id: string;
  /** New base revision after the flush (0 for a deleted entry). */
  revision: number;
  deleted: boolean;
  /** `contentFingerprint` of what the publish wrote; an Undo checks the entry still matches it. */
  fingerprint?: string;
  /** The publish changed Markdown body text, which Undo can't put back (History can). */
  text?: true;
}

export interface PublishConflict {
  collection: string;
  id: string;
  /** Body hashes, structured baselines, or legacy drafts failed validation.
   * The entry was not published and its draft is preserved. */
  reason: "stale_body" | "invalid_body" | "stale_entry" | "legacy_draft" | "invalid_entry" | "uncommitted_source";
  /** For `stale_entry`: the fields changed both in the draft and on the site. */
  fields?: string[];
}

export interface PublishOutcome {
  published: PublishedEntry[];
  /** Internal journal input; never expose source bytes or filesystem paths in API responses. */
  journalSources: PublicationSourceSnapshot[] | null;
  journalVersions: Array<{ collection: string; id: string; revision: number }>;
  conflicts: PublishConflict[];
  failed: Array<{ collection: string; id: string; reason: "storage_error" | "recovery_conflict" }>;
  /** A source file was rewritten, so build-time renders show it only after a rebuild. */
  sourceChanged: boolean;
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
  if (!scope.entries) return out;
  const wanted = new Set(scope.entries.map(entry => JSON.stringify([entry.collection, entry.id])));
  return out.filter(entry => wanted.has(JSON.stringify([entry.collection, entry.id])));
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
 * Flush the overlay into the base. A draft that changes nothing visitors see
 * (edited back, or an undone edit storing only the page's own text) is
 * cleared without a write. A tombstoned draft entry deletes from the
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
  options: PublishOptions = {},
): Promise<PublishOutcome> {
  if (!(await canPublishOverlay(overlay, scope))) throw new PermissionDenied();
  const targets = await overlayEntriesInScope(overlay, scope);
  const published: PublishedEntry[] = [];
  let sourceChanged = false;
  let journalSources: PublicationSourceSnapshot[] | null = [];
  const journalVersions: PublishOutcome["journalVersions"] = [];
  const conflicts: PublishConflict[] = [];
  const failed: PublishOutcome["failed"] = [];
  const drafts = new SessionOverlayAdapter(base, overlay);
  const seeds = await loadPageContent();
  for (const { collection, id } of targets) {
    try {
      await withEntryLock(collection, id, async () => {
        const draftRevision = await overlay.getRevision(collection, id);
        const draft = await overlay.getEntry(collection, id);
        if (!draft) return;
        let plan = recoveryState(draft.data);
        if (!plan && !(await draftChange(drafts, base, collection, id, seeds[collection]?.[id]))) {
          await commitEntryChanges(overlay, [{ collection, id, expectedRevision: draftRevision, expectedExists: true, data: null }]);
          return;
        }
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
          if (options.holdUncommitted && await options.holdUncommitted(collection, id, deleted)) {
            conflicts.push({ collection, id, reason: "uncommitted_source" });
            return;
          }
          const structured = state?.structured ?? (deleted || Object.keys(fields).length > 0);
          if (!state && structured) {
            conflicts.push({ collection, id, reason: "legacy_draft" });
            return;
          }
          const baseSnapshot = await readAdapterSnapshot(base, collection, id);
          const before = baseSnapshot.entry?.data ?? null;
          const beforeRevision = baseSnapshot.revision;
          // The published entry moved since this draft started. Carry the
          // draft over to it; only a field changed on both sides (or a
          // deletion on either side) stops the publish.
          const carried = structured && state && !deleted ? rebaseDraft(state, fields, before) : null;
          if (carried?.conflicts.length || carried?.removed || (deleted && state && (state.baseRevision !== beforeRevision || isStaleDraft(state, before)))) {
            conflicts.push({ collection, id, reason: "stale_entry", ...(carried?.conflicts.length ? { fields: carried.conflicts } : {}) });
            return;
          }
          const merged = deleted ? null : carried ? carried.data : structured ? fields : { ...(before ?? {}), ...fields };
          // Record the template text each saved value replaces, and drop values an edited template has overtaken.
          const after = merged && trackTemplateText(before, merged, seeds[collection]?.[id]).data;
          if ((await validateEntryTransition(base, collection, after)).length) {
            conflicts.push({ collection, id, reason: "invalid_entry" });
            return;
          }
          // Data-file collections (one JSON file of entries) publish through the
          // entry write; only document collections carry a whole source file.
          const documentSource = Boolean(base.readBodySource && base.writeBodySource) &&
            (!base.isDocumentCollection || await base.isDocumentCollection(collection));
          const source = documentSource && base.readBodySource ? await base.readBodySource(collection, id) : null;
          if (blocks?.length && (!source || !base.writeBodySource)) {
            conflicts.push({ collection, id, reason: "invalid_body" });
            return;
          }
          const afterSource = after !== null && documentSource
            ? prepareSource(source ?? "", before, after, blocks ?? []) : undefined;
          if (afterSource === null) {
            conflicts.push({ collection, id, reason: "stale_body" });
            return;
          }
          let preparedJournal: PublicationSourceSnapshot[] | undefined;
          if (base.preparePublicationSources) {
            try {
              const sources = await base.preparePublicationSources(collection, id, after, afterSource);
              if (!validPublicationSources(sources)) throw new Error("Invalid adapter publication snapshots");
              preparedJournal = sources.map(source => ({ ...source }));
            }
            catch (error) { console.warn("[caretcms] Publication journal snapshot unavailable:", error); }
          }
          if (options.journal && (!preparedJournal?.length || !overlay.saveGitJournalReceipt ||
              !overlay.listGitJournalReceipts || !overlay.deleteGitJournalReceipt)) {
            throw new Error("Durable Git journal input is unavailable");
          }
          const context = getRequestContext();
          const editor = context?.identity ?? (context?.editorId ? { id: context.editorId } : null);
          plan = {
            version: 1, beforeRevision, beforeData: before, afterData: after,
            ...(source !== null ? { beforeSource: source } : {}),
            ...(afterSource !== undefined ? { afterSource } : {}),
            ...(preparedJournal !== undefined ? { journalSources: preparedJournal } : {}),
            history: { operationId: crypto.randomUUID(), ts: Date.now(), action: "publish", data: before,
              ...(source !== null ? { bodySource: source } : {}), ...(editor ? { editor } : {}) },
          };
          if (options.journal && preparedJournal?.length && overlay.saveGitJournalReceipt &&
              overlay.listGitJournalReceipts && overlay.deleteGitJournalReceipt) {
            plan.journalReceipt = { version: 1, operationId: plan.history.operationId, collection, id,
              revision: beforeRevision + 1, deleted, sources: preparedJournal, ...structuredClone(options.journal) };
          }
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
        const bodyChanged = typeof plan.beforeSource === "string" && typeof plan.afterSource === "string" &&
          canonicalBody(plan.beforeSource).body !== canonicalBody(plan.afterSource).body;
        published.push({ collection, id, revision, deleted: plan.afterData === null, fingerprint: contentFingerprint(plan.afterData),
          ...(bodyChanged ? { text: true as const } : {}) });
        if (plan.afterSource !== undefined && plan.afterSource !== plan.beforeSource) sourceChanged = true;
        if (!options.journal || !plan.journalReceipt) {
          journalVersions.push({ collection, id, revision: plan.beforeRevision + 1 });
          if (plan.journalSources === undefined) journalSources = null;
          else journalSources?.push(...plan.journalSources);
        }
      });
    } catch (error) {
      if (error instanceof EntryValidationError) {
        conflicts.push({ collection, id, reason: "invalid_entry" });
        continue;
      }
      console.error("[caretcms] Publish requires recovery:", error);
      failed.push({ collection, id, reason: error instanceof RecoveryConflict ? "recovery_conflict" : "storage_error" });
    }
  }
  return { published, conflicts, failed, journalSources, journalVersions, sourceChanged };
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
