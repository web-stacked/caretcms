import type { HistoryEntry, StorageAdapter } from "../types.js";
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
  return r;
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
  const revision = await base.getRevision(collection, id);
  const current = (await base.getEntry(collection, id))?.data ?? null;
  const source = plan.beforeSource !== undefined && base.readBodySource
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
