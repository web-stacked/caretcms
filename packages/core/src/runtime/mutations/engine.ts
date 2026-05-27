import type { StorageAdapter } from "../../types.js";
import { setNestedValue } from "../utils.js";
import {
  parseMutationCommand,
  isRecord,
  type CmsMutationCommand,
  type MutationIssue,
} from "./contracts.js";

/**
 * Per-key chained-promise serializer. Used so an entire
 * `getRevision → writeEntry → bumpRevision` sequence runs atomically
 * for a given entry — without this, two concurrent writes against the
 * same `expectedRevision` can both pass the conflict check and silently
 * overwrite each other.
 */
const mutationLocks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  mutationLocks.set(
    key,
    next.finally(() => {
      if (mutationLocks.get(key) === next) {
        mutationLocks.delete(key);
      }
    }),
  );
  return next;
}

/**
 * Acquire multiple keys' locks before running task. Keys are deduped + sorted
 * so two callers asking for overlapping sets always queue in the same order,
 * avoiding AB-BA deadlocks. Used by multi-entry mutations (reorder) so they
 * compose with single-entry mutations on the same entries.
 */
function withLocks<T>(keys: string[], task: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  const acquire = (idx: number): Promise<T> => {
    if (idx === sorted.length) return task();
    return withLock(sorted[idx], () => acquire(idx + 1));
  };
  return acquire(0);
}

const entryKey = (collection: string, id: string) => `entry::${collection}::${id}`;
const collectionKey = (collection: string) => `collection::${collection}`;

type MutationErrorBody = {
  error: string;
  issues?: MutationIssue[];
  currentRevision?: number;
  conflictId?: string;
};

type MutationResult =
  | { ok: true; body: { ok: true; revision?: number; revisions?: Record<string, number> } }
  | { ok: false; status: number; body: MutationErrorBody };

function fail(status: number, error: string, extra?: Partial<MutationErrorBody>): MutationResult {
  return {
    ok: false,
    status,
    body: {
      error,
      ...extra,
    },
  };
}

async function ensureExpectedRevisionMatches(
  adapter: StorageAdapter,
  collection: string,
  id: string,
  expectedRevision: number | undefined,
): Promise<{ ok: true; currentRevision: number } | { ok: false; result: MutationResult }> {
  const currentRevision = await adapter.getRevision(collection, id);
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    return {
      ok: false,
      result: fail(409, "Revision conflict", { currentRevision }),
    };
  }
  return { ok: true, currentRevision };
}

async function applySaveField(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "save_field" }>,
): Promise<MutationResult> {
  const { collection, id, field, value, expectedRevision } = command;

  return withLock(entryKey(collection, id), async () => {
    const revision = await ensureExpectedRevisionMatches(adapter, collection, id, expectedRevision);
    if (!revision.ok) return revision.result;

    const before = (await adapter.getEntry(collection, id))?.data ?? {};
    const current = { ...before };

    await adapter.appendHistory(collection, id, {
      ts: Date.now(),
      action: "save",
      data: before,
    });

    try {
      setNestedValue(current, field, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Set failed";
      return fail(400, message);
    }

    await adapter.writeEntry(collection, id, current);
    const nextRevision = await adapter.bumpRevision(collection, id);
    return { ok: true, body: { ok: true, revision: nextRevision } };
  });
}

async function applyPutEntry(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "put_entry" }>,
): Promise<MutationResult> {
  const { collection, id, data, expectedRevision } = command;
  return withLock(entryKey(collection, id), async () => {
    const revision = await ensureExpectedRevisionMatches(adapter, collection, id, expectedRevision);
    if (!revision.ok) return revision.result;

    const before = (await adapter.getEntry(collection, id))?.data ?? null;
    if (before !== null) {
      await adapter.appendHistory(collection, id, {
        ts: Date.now(),
        action: "put",
        data: before,
      });
    }

    await adapter.writeEntry(collection, id, data);
    const nextRevision = await adapter.bumpRevision(collection, id);
    return { ok: true, body: { ok: true, revision: nextRevision } };
  });
}

async function applyDeleteEntry(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "delete_entry" }>,
): Promise<MutationResult> {
  const { collection, id, expectedRevision } = command;
  return withLock(entryKey(collection, id), async () => {
    const revision = await ensureExpectedRevisionMatches(adapter, collection, id, expectedRevision);
    if (!revision.ok) return revision.result;

    const before = (await adapter.getEntry(collection, id))?.data ?? null;
    if (before !== null) {
      await adapter.appendHistory(collection, id, {
        ts: Date.now(),
        action: "delete",
        data: before,
      });
    }

    await adapter.deleteEntry(collection, id);
    const nextRevision = await adapter.bumpRevision(collection, id);
    return { ok: true, body: { ok: true, revision: nextRevision } };
  });
}

async function applyReorderEntries(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "reorder_entries" }>,
): Promise<MutationResult> {
  const { collection, items } = command;
  // Hold the per-entry locks for every participating entry, plus a
  // collection-level lock that serializes reorder against itself. Without the
  // per-entry locks, a concurrent save_field on one of these entries can
  // interleave a revision bump between two of ours and tear the revision map.
  const keys = [collectionKey(collection), ...items.map((item) => entryKey(collection, item.id))];
  return withLocks(keys, async () => {
    const currentById = new Map<string, { data: Record<string, unknown>; revision: number }>();

    for (const item of items) {
      const entry = await adapter.getEntry(collection, item.id);
      if (!entry) return fail(404, "Entry not found", { conflictId: item.id });
      const revision = await adapter.getRevision(collection, item.id);
      if (item.expectedRevision !== undefined && item.expectedRevision !== revision) {
        return fail(409, "Revision conflict", {
          conflictId: item.id,
          currentRevision: revision,
        });
      }
      currentById.set(item.id, { data: entry.data, revision });
    }

    const revisions: Record<string, number> = {};
    for (const item of items) {
      const current = currentById.get(item.id);
      if (!current) return fail(500, "Failed to load reorder item");

      await adapter.appendHistory(collection, item.id, {
        ts: Date.now(),
        action: "reorder",
        data: current.data,
      });

      const nextData = { ...current.data, order: item.order };
      await adapter.writeEntry(collection, item.id, nextData);
      revisions[item.id] = await adapter.bumpRevision(collection, item.id);
    }

    return { ok: true, body: { ok: true, revisions } };
  });
}

async function applyUpdatePageLayout(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "update_page_layout" }>,
): Promise<MutationResult> {
  const { collection, id, sections, expectedRevision } = command;
  return withLock(entryKey(collection, id), async () => {
    const revision = await ensureExpectedRevisionMatches(adapter, collection, id, expectedRevision);
    if (!revision.ok) return revision.result;

    const current = (await adapter.getEntry(collection, id))?.data ?? {};
    await adapter.appendHistory(collection, id, {
      ts: Date.now(),
      action: "put",
      data: current,
    });

    const layout =
      current.layout && isRecord(current.layout)
        ? { ...(current.layout as Record<string, unknown>) }
        : {};
    layout.sections = sections.map((section) => ({
      id: section.id,
      key: section.key,
      enabled: section.enabled,
      spacing_y: section.spacing_y,
    }));
    current.layout = layout;

    await adapter.writeEntry(collection, id, current);
    const nextRevision = await adapter.bumpRevision(collection, id);
    return { ok: true, body: { ok: true, revision: nextRevision } };
  });
}

async function applyCreateCollection(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "create_collection" }>,
): Promise<MutationResult> {
  const { id, label, description, icon, creatable, orderable, schema } = command;

  // Check if collection already exists
  const exists = await adapter.isKnownCollection(id);
  if (exists) {
    return fail(409, `Collection "${id}" already exists`);
  }

  const metadata = {
    id,
    label,
    description,
    icon,
    creatable: creatable ?? true,
    orderable: orderable ?? false,
    schema,
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  try {
    await adapter.createCollection(metadata);
    return { ok: true, body: { ok: true } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create collection";
    return fail(500, message);
  }
}

async function applyDeleteCollection(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "delete_collection" }>,
): Promise<MutationResult> {
  const { id } = command;

  // Check if collection exists
  const exists = await adapter.isKnownCollection(id);
  if (!exists) {
    return fail(404, `Collection "${id}" not found`);
  }

  try {
    await adapter.deleteCollection(id);
    return { ok: true, body: { ok: true } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete collection";
    return fail(500, message);
  }
}

export async function executeMutation(adapter: StorageAdapter, input: unknown): Promise<MutationResult> {
  const parsed = await parseMutationCommand(adapter, input);
  if (!parsed.ok) {
    return fail(400, "Invalid mutation command", { issues: parsed.issues });
  }

  const command = parsed.command;
  switch (command.type) {
    case "save_field":
      return applySaveField(adapter, command);
    case "put_entry":
      return applyPutEntry(adapter, command);
    case "delete_entry":
      return applyDeleteEntry(adapter, command);
    case "reorder_entries":
      return applyReorderEntries(adapter, command);
    case "update_page_layout":
      return applyUpdatePageLayout(adapter, command);
    case "create_collection":
      return applyCreateCollection(adapter, command);
    case "delete_collection":
      return applyDeleteCollection(adapter, command);
    default:
      return fail(400, "Unsupported mutation type");
  }
}
