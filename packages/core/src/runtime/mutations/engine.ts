import type { StorageAdapter } from "../../types.js";
import { setNestedValue } from "../utils.js";
import { sanitizeHtml } from "../sanitize-html.js";
import { canonicalBody } from "../../markdown/canonical-body.js";
import { BODY_OVERLAY_KEY, fnv1a32 } from "../../markdown/contracts.js";
import { deriveBlockContext } from "../../markdown/block-context.js";
import { htmlToSNodes, HtmlParseError } from "../../markdown/html-to-snodes.js";
import { serializeBlock, SerializeError } from "../../markdown/serialize.js";
import {
  parseMutationCommand,
  isRecord,
  type CmsMutationCommand,
  type MutationIssue,
} from "./contracts.js";
import { resolveCollectionStudioConfig } from "../schema-registry.js";
import { getRegisteredSchema } from "../schema-registry.js";
import { validateJsonSchema, type JsonSchemaNode } from "../../schema-utils.js";
import { getRequestContext } from "../request-context.js";
import type { HistoryEntry } from "../../types.js";

/** Request-scoped extras a route can thread into `executeMutation`. */
export interface MutationOptions {
  /** Per-tag class allowlist for the md_block HTML re-sanitize. */
  allowedClasses?: Record<string, string[]>;
}

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
  // The value stored for the NEXT waiter must never reject: a rejected stored
  // promise with no attached handler surfaces as a process-level unhandled
  // rejection when `task` throws (e.g. a full or read-only disk). Chain the
  // queue on a settled gate that swallows the rejection; the CALLER still
  // observes `next` with its rejection intact. Mirrors the tail pattern in
  // quota-upload-handler.ts.
  const gate = next.then(
    () => {},
    () => {},
  );
  const stored: Promise<unknown> = gate.then(() => {
    if (mutationLocks.get(key) === stored) {
      mutationLocks.delete(key);
    }
  });
  mutationLocks.set(key, stored);
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

/**
 * Run `task` while holding the same per-entry lock the mutation engine uses,
 * so an out-of-band write (e.g. a history restore) is serialized against any
 * concurrent save_field/put_entry on the same entry instead of interleaving
 * and tearing the data/revision pair.
 */
export function withEntryLock<T>(
  collection: string,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  return withLock(entryKey(collection, id), task);
}

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

async function appendHistory(
  adapter: StorageAdapter,
  collection: string,
  id: string,
  entry: HistoryEntry,
): Promise<void> {
  const context = getRequestContext();
  const editor = context?.identity ?? (context?.editorId ? { id: context.editorId } : null);
  await adapter.appendHistory(collection, id, {
    ...entry,
    ...(editor ? { editor } : {}),
  });
}

async function enforceCollectionCapabilities(
  adapter: StorageAdapter,
  command: CmsMutationCommand,
): Promise<MutationResult | null> {
  if (command.type === "delete_collection") {
    const config = await resolveCollectionStudioConfig(adapter, command.id);
    if (config.deletable === false || config.singletonId) {
      return fail(403, `Collection "${command.id}" cannot be deleted`);
    }
    return null;
  }
  if (!("collection" in command)) return null;
  const config = await resolveCollectionStudioConfig(adapter, command.collection);
  const id = "id" in command && typeof command.id === "string" ? command.id : null;

  if (config.singletonId && id && id !== config.singletonId) {
    return fail(403, `Collection "${command.collection}" only allows entry "${config.singletonId}"`);
  }
  if (command.type === "delete_entry" && (config.deletable === false || config.singletonId)) {
    return fail(403, `Entries in collection "${command.collection}" cannot be deleted`);
  }
  if (command.type === "reorder_entries" && config.orderable === false) {
    return fail(403, `Collection "${command.collection}" cannot be reordered`);
  }

  if (
    id
    && config.creatable === false
    && ["put_entry", "save_field", "update_page_layout", "md_block"].includes(command.type)
  ) {
    const exists = await adapter.getEntry(command.collection, id);
    const initializingSingleton = config.singletonId === id;
    if (!exists && !initializingSingleton) {
      return fail(403, `New entries cannot be created in collection "${command.collection}"`);
    }
  }
  return null;
}

async function collectionSchema(
  adapter: StorageAdapter,
  collection: string,
): Promise<JsonSchemaNode | null> {
  const registered = getRegisteredSchema(collection);
  if (registered) return registered.schema;
  return ((await adapter.getCollectionMetadata(collection))?.schema as JsonSchemaNode | undefined) ?? null;
}

function schemaAtPath(schema: JsonSchemaNode, path: string): JsonSchemaNode | null {
  let current: JsonSchemaNode | undefined = schema;
  for (const segment of path.split(".")) {
    if (!current) return null;
    current = /^\d+$/.test(segment)
      ? current.items
      : current.properties?.[segment];
  }
  return current ?? null;
}

function coerceFieldValue(value: string, schema: JsonSchemaNode | null): unknown {
  if (!schema) return value;
  if (schema.type === "number" || schema.type === "integer") {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : value;
  }
  if (schema.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

function validateEntry(schema: JsonSchemaNode | null, data: Record<string, unknown>): MutationResult | null {
  if (!schema) return null;
  const issues = validateJsonSchema(data, schema);
  return issues.length > 0
    ? fail(400, "Entry does not match collection schema", { issues })
    : null;
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
    const current = structuredClone(before);
    const schema = await collectionSchema(adapter, collection);

    try {
      setNestedValue(current, field, coerceFieldValue(value, schema ? schemaAtPath(schema, field) : null));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Set failed";
      return fail(400, message);
    }

    const validationFailure = validateEntry(schema, current);
    if (validationFailure) return validationFailure;

    // Write first, then record history. If the write throws we surface the
    // error without leaving a history event for a save that never landed.
    await adapter.writeEntry(collection, id, current);
    const nextRevision = await adapter.bumpRevision(collection, id);
    await appendHistory(adapter, collection, id, {
      ts: Date.now(),
      action: "save",
      data: before,
    });
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

    // Carry drafted body blocks forward. The Studio form's payload never
    // contains __body (read boundaries strip it and the parse contract rejects
    // it), so a full-entry save must not clobber body drafts already stored in
    // the overlay — a frontmatter edit and an inline body edit are separate
    // concerns that both live on the same draft record.
    const write =
      before && before[BODY_OVERLAY_KEY] !== undefined
        ? { ...data, [BODY_OVERLAY_KEY]: before[BODY_OVERLAY_KEY] }
        : data;

    const validationFailure = validateEntry(await collectionSchema(adapter, collection), data);
    if (validationFailure) return validationFailure;

    await adapter.writeEntry(collection, id, write);
    const nextRevision = await adapter.bumpRevision(collection, id);
    if (before !== null) {
      await appendHistory(adapter, collection, id, {
        ts: Date.now(),
        action: "put",
        data: before,
      });
    }
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

    await adapter.deleteEntry(collection, id);
    const nextRevision = await adapter.bumpRevision(collection, id);
    if (before !== null) {
      await appendHistory(adapter, collection, id, {
        ts: Date.now(),
        action: "delete",
        data: before,
      });
    }
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

    const schema = await collectionSchema(adapter, collection);
    const pending = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const current = currentById.get(item.id);
      if (!current) return fail(500, "Failed to load reorder item");

      const nextData = { ...current.data, order: item.order };
      const validationFailure = validateEntry(schema, nextData);
      if (validationFailure) return validationFailure;
      pending.set(item.id, nextData);
    }

    // Validate the complete batch before writing any member so one invalid
    // entry cannot leave a partially reordered collection behind.
    const revisions: Record<string, number> = {};
    for (const item of items) {
      const current = currentById.get(item.id);
      const nextData = pending.get(item.id);
      if (!current || !nextData) return fail(500, "Failed to prepare reorder item");
      await adapter.writeEntry(collection, item.id, nextData);
      revisions[item.id] = await adapter.bumpRevision(collection, item.id);
      await appendHistory(adapter, collection, item.id, {
        ts: Date.now(),
        action: "reorder",
        data: current.data,
      });
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
    // Snapshot the pre-mutation state for history before we mutate `current`.
    const before = structuredClone(current);

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
    await appendHistory(adapter, collection, id, {
      ts: Date.now(),
      action: "put",
      data: before,
    });
    return { ok: true, body: { ok: true, revision: nextRevision } };
  });
}

/**
 * Store one edited markdown body block in the entry's draft data under the
 * reserved `__body` key. The adapter here is ALWAYS the editor's draft overlay
 * (the route builds it explicitly) — the base markdown adapter serializes
 * entry data into frontmatter, where `__body` must never land.
 *
 * Trust model: the client sends only HTML. It is re-sanitized against the rich
 * allowlist, parsed into the closed inline set, and the markdown that publish
 * will eventually splice into the source file is derived HERE — a client can't
 * inject raw markdown (and thus raw HTML blocks) into anyone's `.md`. The
 * block's identity is proven by hashing the current source at the claimed
 * range; any drift (external edit, prior publish) fails 409 and the client
 * re-reads the freshly stamped page.
 */
async function applyMdBlock(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "md_block" }>,
  options?: MutationOptions,
): Promise<MutationResult> {
  const { collection, id, blockPath, src, html, expectedRevision } = command;

  return withLock(entryKey(collection, id), async () => {
    const revision = await ensureExpectedRevisionMatches(adapter, collection, id, expectedRevision);
    if (!revision.ok) return revision.result;

    if (typeof adapter.readBodySource !== "function") {
      return fail(400, "Body editing requires a source-file storage adapter");
    }
    const file = await adapter.readBodySource(collection, id);
    if (file === null) return fail(404, "Entry source not found");

    const { body } = canonicalBody(file);
    if (src.end > body.length || fnv1a32(body.slice(src.start, src.end)) !== src.hash) {
      return fail(409, "Body block is stale", { currentRevision: revision.currentRevision });
    }

    const clean = sanitizeHtml(html, { allowedClasses: options?.allowedClasses });
    let md: string;
    try {
      md = serializeBlock(htmlToSNodes(clean), deriveBlockContext(body, src));
    } catch (error) {
      if (error instanceof SerializeError || error instanceof HtmlParseError) {
        return fail(400, error.message);
      }
      throw error;
    }

    // The source file exists (readBodySource succeeded above), so a null entry
    // here means the entry is DRAFT-DELETED (the overlay hides it behind a
    // tombstone). Writing a body draft would silently resurrect it.
    const beforeEntry = await adapter.getEntry(collection, id);
    if (beforeEntry === null) {
      return fail(409, "Entry was deleted in this draft — publish or discard the deletion first", {
        currentRevision: revision.currentRevision,
      });
    }
    const before = beforeEntry.data;
    // Write back the overlay's OWN prior data (draft deltas) plus this block —
    // NEVER a base frontmatter snapshot. Snapshotting base here is what let a
    // later publish flush stale frontmatter over a field edited straight to
    // base in the meantime (Studio field saves bypass the overlay in server
    // delivery). Fall back to the merged entry for non-overlay adapters, which
    // have no separate base to protect.
    const overlayRead = adapter as {
      getOwnEntry?: (c: string, i: string) => Promise<{ data: Record<string, unknown> } | null>;
    };
    const ownData =
      typeof overlayRead.getOwnEntry === "function"
        ? (await overlayRead.getOwnEntry(collection, id))?.data ?? {}
        : before;
    const current: Record<string, unknown> = { ...ownData };
    const drafts = isRecord(current[BODY_OVERLAY_KEY])
      ? { ...(current[BODY_OVERLAY_KEY] as Record<string, unknown>) }
      : {};
    // blockPath is /^\d+(\.\d+)*$/ by the parse contract — safe as an own key.
    drafts[blockPath] = { md, html: clean, src, ts: Date.now() };
    current[BODY_OVERLAY_KEY] = drafts;

    await adapter.writeEntry(collection, id, current);
    const nextRevision = await adapter.bumpRevision(collection, id);
    await appendHistory(adapter, collection, id, {
      ts: Date.now(),
      action: "save",
      data: before,
    });
    return { ok: true, body: { ok: true, revision: nextRevision } };
  });
}

async function applyCreateCollection(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "create_collection" }>,
): Promise<MutationResult> {
  const {
    id, label, description, icon, creatable, orderable, deletable,
    singletonId, order, schema,
  } = command;

  // Hold the collection lock so the exists-check → create is atomic (two
  // concurrent creates can't both pass the check) and serializes against a
  // concurrent delete_collection / reorder_entries on the same collection.
  return withLock(collectionKey(id), async () => {
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
      deletable: deletable ?? true,
      singletonId,
      order,
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
  });
}

async function applyDeleteCollection(
  adapter: StorageAdapter,
  command: Extract<CmsMutationCommand, { type: "delete_collection" }>,
): Promise<MutationResult> {
  const { id } = command;

  // Hold the collection lock (same key reorder_entries acquires) so a delete
  // can't interleave with an in-flight reorder/create on the same collection.
  return withLock(collectionKey(id), async () => {
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
  });
}

export async function executeMutation(
  adapter: StorageAdapter,
  input: unknown,
  options?: MutationOptions,
): Promise<MutationResult> {
  const parsed = await parseMutationCommand(adapter, input);
  if (!parsed.ok) {
    return fail(400, "Invalid mutation command", { issues: parsed.issues });
  }

  const command = parsed.command;
  const capabilityFailure = await enforceCollectionCapabilities(adapter, command);
  if (capabilityFailure) return capabilityFailure;
  switch (command.type) {
    case "md_block":
      return applyMdBlock(adapter, command, options);
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
