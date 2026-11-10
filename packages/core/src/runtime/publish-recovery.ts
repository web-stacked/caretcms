import { validGitJournalReceipt } from "./git-journal-receipt.js";
import { validateEntryTransition, EntryValidationError } from "./entry-validation.js";
import { readAdapterSnapshot } from "./storage/read-snapshot.js";
import type { HistoryEntry, StorageAdapter, PublicationSourceSnapshot, GitJournalReceipt } from "../types.js";
import { PUBLISH_RECOVERY_KEY, sameContent } from "./draft-state.js";
import { rewriteFrontmatter } from "./storage/frontmatter-codec.js";
import { spliceBodyBlocks } from "../markdown/splice.js";
import { commitEntryChanges } from "./storage/entry-commit.js";

export interface PublishRecovery {
  version: 1;
  beforeRevision: number;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  beforeSource?: string;
  afterSource?: string;
  journalSources?: PublicationSourceSnapshot[];
  journalReceipt?: GitJournalReceipt;
  history: HistoryEntry & { operationId: string };
}

export class RecoveryConflict extends Error {}

export function recoveryState(data: Record<string, unknown>): PublishRecovery | null {
  const raw = data[PUBLISH_RECOVERY_KEY];
  if (raw === undefined) return null;
  const r = raw as PublishRecovery;
  const recordOrNull = (value: unknown) => value === null ||
    (typeof value === "object" && !Array.isArray(value));
  if (!r || r.version !== 1 || !Number.isSafeInteger(r.beforeRevision) || r.beforeRevision < 0 ||
      !recordOrNull(r.beforeData) || !recordOrNull(r.afterData) ||
      !r.history || typeof r.history.operationId !== "string" || !Number.isFinite(r.history.ts) ||
      (r.beforeSource !== undefined && typeof r.beforeSource !== "string") ||
      (r.afterSource !== undefined && typeof r.afterSource !== "string")) {
    throw new RecoveryConflict("Invalid publish recovery record");
  }
  if (r.journalSources !== undefined && !validPublicationSources(r.journalSources)) {
    throw new RecoveryConflict("Invalid publication source snapshots");
  }
  if (r.journalReceipt !== undefined && (!validGitJournalReceipt(r.journalReceipt) ||
      r.journalReceipt.operationId !== r.history.operationId || r.journalReceipt.revision !== r.beforeRevision + 1 ||
      r.journalReceipt.deleted !== (r.afterData === null) || !sameContent(r.journalReceipt.sources, r.journalSources))) {
    throw new RecoveryConflict("Invalid Git journal recovery receipt");
  }
  return r;
}

export function validPublicationSources(value: unknown): value is PublicationSourceSnapshot[] {
  return Array.isArray(value) && value.every(s => s && typeof s.path === "string" && s.path &&
    !s.path.includes("\0") && (s.content === null || typeof s.content === "string") &&
    (s.mode === undefined || s.mode === "100644" || s.mode === "100755"));
}

/** Prepare the entire Markdown file before any source write, preserving untouched YAML. */
export function prepareSource(
  source: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  blocks: ReadonlyArray<{ md: string; src: { start: number; end: number; hash: string } }>,
): string | null {
  const spliced = spliceBodyBlocks(source, blocks);
  if (!spliced.ok) return null;
  if (sameContent(before, after)) return spliced.content;
  const rewritten = rewriteFrontmatter(spliced.content, after);
  if (!rewritten.ok) throw new Error("Cannot prepare source content");
  return rewritten.content;
}

/**
 * Forward recovery under the entry lock. The overlay's atomic write persists
 * this plan before touching base content. Each subsequent step is checked so a
 * lost acknowledgement/restart cannot apply the source edit or revision twice.
 * This is recoverability, not atomic visibility or a distributed transaction.
 */
export async function resumePublish(
  base: StorageAdapter, overlay: StorageAdapter, collection: string, id: string,
  plan: PublishRecovery,
): Promise<number> {
  const snapshot = await readAdapterSnapshot(base, collection, id);
  const revision = snapshot.revision;
  const current = snapshot.entry?.data ?? null;
  const source = (plan.beforeSource !== undefined || plan.afterSource !== undefined) && base.readBodySource
    ? await base.readBodySource(collection, id) : undefined;
  const atBefore = sameContent(current, plan.beforeData) &&
    (plan.beforeSource === undefined || source === plan.beforeSource);
  const atAfter = sameContent(current, plan.afterData) &&
    (plan.afterSource === undefined || source === plan.afterSource);
  if ((!atBefore && !atAfter) || (revision !== plan.beforeRevision && revision !== plan.beforeRevision + 1) ||
      (revision === plan.beforeRevision + 1 && !atAfter)) {
    throw new RecoveryConflict("Published content changed during recovery");
  }
  let committedTransition = false;
  if (!atAfter) {
    // An already applied source/data transition must finish its bookkeeping
    // even if the schema changed after persistence. Pending writes revalidate.
    const issues = await validateEntryTransition(base, collection, plan.afterData);
    if (issues.length) throw new EntryValidationError(issues);
    if (plan.afterSource === undefined) {
      const committed = await commitEntryChanges(base, [{
        collection,
        id,
        expectedRevision: plan.beforeRevision,
        expectedExists: plan.beforeData !== null,
        data: plan.afterData,
        history: plan.history,
      }]);
      if (!committed.ok) throw new RecoveryConflict("Published content changed during recovery");
      committedTransition = true;
    } else if (base.writeBodySource) {
      await base.writeBodySource(collection, id, plan.afterSource);
    } else {
      throw new RecoveryConflict("Source-backed publication is unavailable");
    }
  }
  if (!committedTransition && revision === plan.beforeRevision) {
    const next = await base.bumpRevision(collection, id);
    if (next !== plan.beforeRevision + 1) throw new RecoveryConflict("Unexpected revision during recovery");
  }
  if (!committedTransition) {
    const history = await base.getHistory(collection, id);
    if (!history.some(entry => entry.operationId === plan.history.operationId)) {
      await base.appendHistory(collection, id, plan.history);
    }
  }
  if (plan.journalReceipt) {
    if (plan.journalReceipt.collection !== collection || plan.journalReceipt.id !== id || !overlay.saveGitJournalReceipt) {
      throw new RecoveryConflict("Durable Git journal queue is unavailable");
    }
    // Persist retry input before deleting the only remaining publication plan.
    await overlay.saveGitJournalReceipt(plan.journalReceipt);
  }
  const overlayRevision = await overlay.getRevision(collection, id);
  const overlayEntry = await overlay.getEntry(collection, id);
  if (overlayEntry) {
    const cleared = await commitEntryChanges(overlay, [{
      collection, id, expectedRevision: overlayRevision, expectedExists: true, data: null,
    }]);
    if (!cleared.ok) throw new RecoveryConflict("Draft changed during publication cleanup");
  }
  return plan.afterData === null ? 0 : plan.beforeRevision + 1;
}
