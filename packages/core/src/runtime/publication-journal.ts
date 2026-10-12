import type { StorageAdapter } from "../types.js";
import { withEntryLocks } from "./mutations/engine.js";
import { commitSnapshots, readGitJournalCommit, type SnapshotCommitOptions } from "./git-journal.js";

/** Avoid committing an older CMS publication over a newer one in this process. */
export function journalPublishedEntries(
  base: StorageAdapter,
  versions: ReadonlyArray<{ collection: string; id: string; revision: number }>,
  options: SnapshotCommitOptions,
): Promise<string | null> {
  return withEntryLocks(versions, async () => {
    for (const entry of versions) {
      if (await base.getRevision(entry.collection, entry.id) !== entry.revision) {
        console.warn("[caretcms] Git journal skipped: a newer content revision is already stored.");
        return null;
      }
    }
    // Keep the locks until Git finishes so a later CMS save/publish cannot
    // advance base after comparison and before this commit. External file
    // editors remain free to write; their bytes never enter the approved tree.
    return commitSnapshots(options);
  });
}

export function durableGitJournalEnabled(): boolean {
  return process.env.CARET_GIT_ON_PUBLISH === "true" && process.env.CARET_GIT_JOURNAL_RETRY === "true";
}

export function hasGitJournalQueue(overlay: StorageAdapter): boolean {
  return Boolean(overlay.listGitJournalReceipts && overlay.saveGitJournalReceipt && overlay.deleteGitJournalReceipt);
}

/** Permission preflight is shared by normal publication, explicit retry, and UI state. */
export async function canRetryPublicationJournals(overlay: StorageAdapter, scope: { collection?: string; id?: string } = {}): Promise<boolean> {
  const { canPerform } = await import("./authorization.js");
  const { validGitJournalReceipt } = await import("./git-journal-receipt.js");
  const receipts = await overlay.listGitJournalReceipts?.() ?? [];
  if (!receipts.every(validGitJournalReceipt)) throw new Error("Invalid Git journal receipt");
  for (const receipt of receipts.filter(receipt => (!scope.collection || receipt.collection === scope.collection) && (!scope.id || receipt.id === scope.id))) {
    if (!(await canPerform("publish", receipt.collection, receipt.id)) ||
        (receipt.deleted && !(await canPerform("delete", receipt.collection, receipt.id)))) return false;
  }
  return true;
}

export interface JournalRetryOutcome {
  completed: number;
  pending: number;
  blocked: number;
  commit: string | null;
}

/** Retry private receipts only; never reapply content, history, or rebuild hooks. */
export async function retryPublicationJournals(
  base: StorageAdapter,
  overlay: StorageAdapter,
  cwd: string,
  scope: { collection?: string; id?: string } = {},
): Promise<JournalRetryOutcome> {
  const { requirePermission } = await import("./authorization.js");
  const { validGitJournalReceipt } = await import("./git-journal-receipt.js");
  if (!overlay.listGitJournalReceipts || !overlay.deleteGitJournalReceipt) throw new Error("Durable Git journal queue is unavailable");
  const all = await overlay.listGitJournalReceipts();
  if (!all.every(validGitJournalReceipt)) throw new Error("Invalid Git journal receipt");
  const receipts = all.filter(receipt => (!scope.collection || receipt.collection === scope.collection) && (!scope.id || receipt.id === scope.id));
  // Preflight every permission before creating any Git commits.
  if (!receipts.length) await requirePermission("publish", scope.collection, scope.id);
  for (const receipt of receipts) {
    await requirePermission("publish", receipt.collection, receipt.id);
    if (receipt.deleted) await requirePermission("delete", receipt.collection, receipt.id);
  }
  let completed = 0, blocked = 0, commit: string | null = null;
  for (const receipt of receipts) {
    try {
      const journal = { operationId: receipt.operationId, target: receipt.target };
      const sha = await withEntryLocks([receipt], async () => {
        // A successful-but-unacknowledged Git operation needs only queue cleanup.
        const previous = await readGitJournalCommit(cwd, journal);
        if (previous) return previous;
        const { recoveryState } = await import("./publish-recovery.js");
        const draft = await overlay.getEntry(receipt.collection, receipt.id);
        if (draft && recoveryState(draft.data)?.history.operationId === receipt.operationId) return null;
        if (await base.getRevision(receipt.collection, receipt.id) !== receipt.revision) { blocked++; return null; }
        return commitSnapshots({ cwd, sources: receipt.sources, journal,
          message: `publish ${receipt.collection}/${receipt.id}`, authorName: receipt.authorName, authorEmail: receipt.authorEmail });
      });
      if (!sha) continue;
      commit = sha;
      await overlay.deleteGitJournalReceipt(receipt.operationId);
      completed++;
    } catch (error) {
      console.warn("[caretcms] Git journal retry remains pending:", (error as Error).message);
    }
  }
  return { completed, pending: receipts.length - completed, blocked, commit };
}
