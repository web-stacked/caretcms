import type {
  CollectionMetadata,
  DeploymentTarget,
  EntryCommit,
  EntryCommitResult,
  HistoryEntry,
  RebuildReceipt,
} from "@caretcms/core";

const HISTORY_LIMIT = 50;
const COLLECTION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

type StoredEntry =
  | { state: "entry"; data: Record<string, unknown> }
  | { state: "deleted" };

export interface DurableStorageTxn {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface DurableStorageLike extends DurableStorageTxn {
  transaction<T>(task: (txn: DurableStorageTxn) => Promise<T>): Promise<T>;
  deleteAll(): Promise<void>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

type CommitWireChange = EntryCommit & { seedData?: Record<string, unknown> };

type DurableCommand =
  | { type: "get_rebuild_receipt" }
  | { type: "set_rebuild_receipt"; receipt: RebuildReceipt | null }
  | { type: "get_deployment_target" }
  | { type: "set_deployment_target"; target: DeploymentTarget | null }
  | { type: "collections" }
  | { type: "get_entry"; collection: string; id: string }
  | { type: "list_entry_ids"; collection: string }
  | { type: "write_entry"; collection: string; id: string; data: Record<string, unknown> }
  | { type: "delete_entry"; collection: string; id: string }
  | { type: "get_revision"; collection: string; id: string }
  | { type: "bump_revision"; collection: string; id: string }
  | { type: "get_history"; collection: string; id: string }
  | { type: "append_history"; collection: string; id: string; entry: HistoryEntry }
  | { type: "commit_entries"; changes: CommitWireChange[] }
  | { type: "create_collection"; metadata: CollectionMetadata }
  | { type: "delete_collection"; collection: string }
  | { type: "get_collection_metadata"; collection: string }
  | { type: "list_collection_metadata" };

const entryKey = (c: string, id: string) => `entry::${c}::${id}`;
const revisionKey = (c: string, id: string) => `revision::${c}::${id}`;
const historyKey = (c: string, id: string) => `history::${c}::${id}`;
const indexKey = (c: string) => `index::${c}`;
const deletedIndexKey = (c: string) => `deleted-index::${c}`;
const metadataKey = (c: string) => `metadata::${c}`;
const COLLECTIONS_KEY = "collections";
const DELETED_COLLECTIONS_KEY = "deleted-collections";
const REBUILD_RECEIPT_KEY = "rebuild-receipt";
const DEPLOYMENT_TARGET_KEY = "deployment-target";

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function revision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function history(value: unknown): HistoryEntry[] {
  return Array.isArray(value) ? value.slice(0, HISTORY_LIMIT) as HistoryEntry[] : [];
}

async function addSorted(txn: DurableStorageTxn, key: string, value: string): Promise<void> {
  const current = strings(await txn.get(key));
  if (!current.includes(value)) current.push(value);
  current.sort((a, b) => a.localeCompare(b));
  await txn.put(key, current);
}

async function removeValue(txn: DurableStorageTxn, key: string, value: string): Promise<void> {
  const current = strings(await txn.get(key));
  await txn.put(key, current.filter(item => item !== value));
}

async function writeEntryState(
  txn: DurableStorageTxn,
  collection: string,
  id: string,
  data: Record<string, unknown> | null,
): Promise<void> {
  if (data === null) {
    await txn.put<StoredEntry>(entryKey(collection, id), { state: "deleted" });
    await removeValue(txn, indexKey(collection), id);
    await addSorted(txn, deletedIndexKey(collection), id);
    return;
  }
  await txn.put<StoredEntry>(entryKey(collection, id), { state: "entry", data });
  await addSorted(txn, indexKey(collection), id);
  await removeValue(txn, deletedIndexKey(collection), id);
  await addSorted(txn, COLLECTIONS_KEY, collection);
  await removeValue(txn, DELETED_COLLECTIONS_KEY, collection);
}

async function commitEntries(
  storage: DurableStorageLike,
  changes: CommitWireChange[],
): Promise<EntryCommitResult> {
  return storage.transaction(async txn => {
    const deletedCollections = strings(await txn.get(DELETED_COLLECTIONS_KEY));
    for (const change of changes) {
      const stored = await txn.get<StoredEntry>(entryKey(change.collection, change.id));
      const collectionDeleted = deletedCollections.includes(change.collection);
      const exists = !collectionDeleted &&
        (stored?.state === "entry" || (!stored && change.seedData !== undefined));
      const currentRevision = revision(await txn.get(revisionKey(change.collection, change.id)));
      if (currentRevision !== change.expectedRevision || exists !== change.expectedExists) {
        return { ok: false, conflict: {
          collection: change.collection,
          id: change.id,
          currentRevision,
          exists,
        } };
      }
    }

    const revisions: Array<{ collection: string; id: string; revision: number }> = [];
    for (const change of changes) {
      await writeEntryState(txn, change.collection, change.id, change.data);
      const next = change.expectedRevision + 1;
      await txn.put(revisionKey(change.collection, change.id), next);
      if (change.history) {
        const current = history(await txn.get(historyKey(change.collection, change.id)));
        await txn.put(historyKey(change.collection, change.id), [change.history, ...current].slice(0, HISTORY_LIMIT));
      }
      revisions.push({ collection: change.collection, id: change.id, revision: next });
    }
    return { ok: true, revisions };
  });
}

function validCommand(value: unknown): value is DurableCommand {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string");
}

export async function handleDurableStorageRequest(
  storage: DurableStorageLike,
  request: Request,
): Promise<Response> {
  try {
    const command: unknown = await request.json();
    if (!validCommand(command)) return Response.json({ error: "Invalid storage command" }, { status: 400 });

    const ttl = Number(request.headers.get("x-caret-ttl-seconds"));
    if (Number.isSafeInteger(ttl) && ttl > 0 && storage.setAlarm) {
      await storage.setAlarm(Date.now() + ttl * 1000);
    }

    switch (command.type) {
      case "get_rebuild_receipt":
        return Response.json({ value: await storage.get(REBUILD_RECEIPT_KEY) ?? null });
      case "set_rebuild_receipt":
        if (command.receipt === null) await storage.delete(REBUILD_RECEIPT_KEY);
        else await storage.put(REBUILD_RECEIPT_KEY, command.receipt);
        return Response.json({ ok: true });
      case "get_deployment_target":
        return Response.json({ value: await storage.get(DEPLOYMENT_TARGET_KEY) ?? null });
      case "set_deployment_target":
        if (command.target === null) await storage.delete(DEPLOYMENT_TARGET_KEY);
        else await storage.put(DEPLOYMENT_TARGET_KEY, command.target);
        return Response.json({ ok: true });
      case "collections":
        return Response.json({
          known: strings(await storage.get(COLLECTIONS_KEY)),
          deleted: strings(await storage.get(DELETED_COLLECTIONS_KEY)),
        });
      case "get_entry":
        return Response.json({
          value: await storage.get<StoredEntry>(entryKey(command.collection, command.id)) ?? null,
          collectionDeleted: strings(await storage.get(DELETED_COLLECTIONS_KEY)).includes(command.collection),
        });
      case "list_entry_ids": {
        const collectionDeleted = strings(await storage.get(DELETED_COLLECTIONS_KEY)).includes(command.collection);
        return Response.json({
          ids: strings(await storage.get(indexKey(command.collection))),
          deleted: strings(await storage.get(deletedIndexKey(command.collection))),
          collectionDeleted,
        });
      }
      case "write_entry":
        await storage.transaction(txn => writeEntryState(txn, command.collection, command.id, command.data));
        return Response.json({ ok: true });
      case "delete_entry":
        await storage.transaction(txn => writeEntryState(txn, command.collection, command.id, null));
        return Response.json({ ok: true });
      case "get_revision":
        return Response.json({ value: revision(await storage.get(revisionKey(command.collection, command.id))) });
      case "bump_revision": {
        const value = await storage.transaction(async txn => {
          const next = revision(await txn.get(revisionKey(command.collection, command.id))) + 1;
          await txn.put(revisionKey(command.collection, command.id), next);
          return next;
        });
        return Response.json({ value });
      }
      case "get_history":
        return Response.json({ value: history(await storage.get(historyKey(command.collection, command.id))) });
      case "append_history":
        await storage.transaction(async txn => {
          const current = history(await txn.get(historyKey(command.collection, command.id)));
          await txn.put(historyKey(command.collection, command.id), [command.entry, ...current].slice(0, HISTORY_LIMIT));
        });
        return Response.json({ ok: true });
      case "commit_entries":
        return Response.json(await commitEntries(storage, command.changes));
      case "create_collection":
        if (!COLLECTION_NAME_RE.test(command.metadata.id)) throw new Error("Invalid collection id");
        {
          const created = await storage.transaction(async txn => {
          const existing = await txn.get(metadataKey(command.metadata.id));
          const known = strings(await txn.get(COLLECTIONS_KEY));
          if (existing || known.includes(command.metadata.id)) return false;
          await txn.put(metadataKey(command.metadata.id), command.metadata);
          await addSorted(txn, COLLECTIONS_KEY, command.metadata.id);
          await removeValue(txn, DELETED_COLLECTIONS_KEY, command.metadata.id);
          if (!Array.isArray(await txn.get(indexKey(command.metadata.id)))) {
            await txn.put(indexKey(command.metadata.id), []);
          }
          return true;
        });
          if (!created) return Response.json({ error: "Collection already exists" }, { status: 409 });
        }
        return Response.json({ ok: true });
      case "delete_collection":
        await storage.transaction(async txn => {
          const ids = [...new Set([
            ...strings(await txn.get(indexKey(command.collection))),
            ...strings(await txn.get(deletedIndexKey(command.collection))),
          ])];
          for (const id of ids) {
            await txn.delete(entryKey(command.collection, id));
            await txn.delete(revisionKey(command.collection, id));
            await txn.delete(historyKey(command.collection, id));
          }
          await txn.delete(indexKey(command.collection));
          await txn.delete(deletedIndexKey(command.collection));
          await txn.delete(metadataKey(command.collection));
          await removeValue(txn, COLLECTIONS_KEY, command.collection);
          await addSorted(txn, DELETED_COLLECTIONS_KEY, command.collection);
        });
        return Response.json({ ok: true });
      case "get_collection_metadata":
        return Response.json({ value: await storage.get(metadataKey(command.collection)) ?? null });
      case "list_collection_metadata": {
        const known = strings(await storage.get(COLLECTIONS_KEY));
        const values = (await Promise.all(known.map(id => storage.get<CollectionMetadata>(metadataKey(id)))))
          .filter((value): value is CollectionMetadata => Boolean(value));
        return Response.json({ value: values });
      }
    }
  } catch (error) {
    console.error("[caretcms] Durable storage request failed:", error);
    return Response.json({ error: "Storage request failed" }, { status: 500 });
  }
}
