import type {
  EditorIdentity,
  EntryCommit,
  EntryCommitResult,
  HistoryEntry,
  StorageAdapter,
} from "../../types.js";
import { getRequestContext } from "../request-context.js";

export function historyForEditor(entry: HistoryEntry): HistoryEntry {
  const context = getRequestContext();
  const editor: EditorIdentity | null =
    context?.identity ?? (context?.editorId ? { id: context.editorId } : null);
  return { ...entry, ...(editor ? { editor } : {}) };
}

/**
 * Use a distributed adapter's atomic primitive when available. The fallback is
 * intended for adapters protected by the mutation engine's in-process locks.
 */
export async function commitEntryChanges(
  adapter: StorageAdapter,
  changes: readonly EntryCommit[],
): Promise<EntryCommitResult> {
  if (adapter.commitEntries) return adapter.commitEntries(changes);

  for (const change of changes) {
    const [currentRevision, current] = await Promise.all([
      adapter.getRevision(change.collection, change.id),
      adapter.getEntry(change.collection, change.id),
    ]);
    if (currentRevision !== change.expectedRevision || Boolean(current) !== change.expectedExists) {
      return {
        ok: false,
        conflict: {
          collection: change.collection,
          id: change.id,
          currentRevision,
          exists: Boolean(current),
        },
      };
    }
  }

  const revisions: Array<{ collection: string; id: string; revision: number }> = [];
  for (const change of changes) {
    if (change.data === null) await adapter.deleteEntry(change.collection, change.id);
    else await adapter.writeEntry(change.collection, change.id, change.data);
    const revision = await adapter.bumpRevision(change.collection, change.id);
    if (change.history) {
      await adapter.appendHistory(change.collection, change.id, change.history);
    }
    revisions.push({ collection: change.collection, id: change.id, revision });
  }
  return { ok: true, revisions };
}
