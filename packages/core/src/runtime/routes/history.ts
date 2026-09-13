import { canPerform } from "../authorization.js";
import { getRequestContext } from "../request-context.js";
import { getRuntimeServices } from "../providers.js";
export const prerender = false;

import type { APIContext } from "astro";
import { getEditorIdentity, isEditorAuthenticated } from "../auth/session.js";
import { parseEntryId } from "../mutations/contracts.js";
import { withEntryLock } from "../mutations/engine.js";
import { commitEntryChanges } from "../storage/entry-commit.js";
import { json, resolveAdapter, enforceCsrfHeader, readJsonBody } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const adapter = getRequestContext()?.authorize ? (await getRuntimeServices()).adapter : await resolveAdapter();
  const collectionRaw = (context.url.searchParams.get("collection") ?? "")
    .trim()
    .toLowerCase();
  const id = parseEntryId(context.url.searchParams.get("id"));

  if (!(await adapter.isKnownCollection(collectionRaw)) || !id) {
    return json({ error: "Invalid collection or id" }, 400);
  }

  const history = await adapter.getHistory(collectionRaw, id);
  return json({ history });
}

export async function POST(context: APIContext): Promise<Response> {
  const csrfFailure = enforceCsrfHeader(context.request);
  if (csrfFailure) return csrfFailure;

  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const body =
    parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>)
      : null;
  if (!body) return json({ error: "Invalid payload" }, 400);

  const adapter = getRequestContext()?.authorize ? (await getRuntimeServices()).adapter : await resolveAdapter();
  const collectionRaw = typeof body.collection === "string"
    ? body.collection.trim().toLowerCase()
    : "";
  const id = parseEntryId(body.id) ?? "";
  const ts = typeof body.ts === "number" && Number.isFinite(body.ts) ? body.ts : NaN;

  if (!(await adapter.isKnownCollection(collectionRaw)) || !id || !Number.isFinite(ts)) {
    return json({ error: "Invalid restore payload" }, 400);
  }

  if (!(await canPerform("edit", collectionRaw, id)) || !(await canPerform("publish", collectionRaw, id))) {
    return json({ error: "Permission denied" }, 403);
  }

  try {
    const editor = getEditorIdentity(context);
    const entries = await adapter.getHistory(collectionRaw, id);
    const snapshot = entries.find((entry) => entry.ts === ts);
    if (!snapshot) return json({ error: "Snapshot not found" }, 404);
    if (!snapshot.data || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)) {
      return json({ error: "Snapshot data invalid" }, 500);
    }
    const snapshotData = snapshot.data as Record<string, unknown>;

    // Hold the engine's per-entry lock so the restore can't interleave with a
    // concurrent save_field/put_entry and tear the entry/revision pair. Write
    // before appending history so a failed write doesn't record a phantom event.
    const restored = await withEntryLock(collectionRaw, id, async () => {
      const beforeRevision = await adapter.getRevision(collectionRaw, id);
      const before = await adapter.getEntry(collectionRaw, id);
      // A publish snapshot that spliced body blocks carries the full
      // pre-publish source file — restore that exact file (prose + frontmatter
      // formatting). Its frontmatter already represents snapshotData, so a
      // follow-up writeEntry would only reserialize it and destroy byte parity.
      if (typeof snapshot.bodySource === "string" && adapter.writeBodySource) {
        const currentSource = await adapter.readBodySource?.(collectionRaw, id);
        await adapter.writeBodySource(collectionRaw, id, snapshot.bodySource);
        const next = await adapter.bumpRevision(collectionRaw, id);
        // Undo-of-the-undo: record what the file looked like before this restore.
        await adapter.appendHistory(collectionRaw, id, {
          ts: Date.now(),
          action: "restore",
          data: before?.data ?? snapshotData,
          ...(typeof currentSource === "string" ? { bodySource: currentSource } : {}),
          ...(editor ? { editor } : {}),
        });
        return { revision: next, data: snapshotData };
      }

      const committed = await commitEntryChanges(adapter, [{
        collection: collectionRaw,
        id,
        expectedRevision: beforeRevision,
        expectedExists: Boolean(before),
        data: snapshotData,
        history: {
          ts: Date.now(),
          action: "restore",
          data: before?.data ?? snapshotData,
          ...(editor ? { editor } : {}),
        },
      }]);
      if (!committed.ok) throw new Error("Entry changed while restoring history");
      const next = committed.revisions[0].revision;
      return { revision: next, data: snapshotData };
    });

    return json({ ok: true, revision: restored.revision, data: restored.data });
  } catch (error) {
    // An adapter throw must not leak a stack/path via a framework 500.
    console.error("[caretcms] History restore failed:", error);
    return json({ error: "Restore failed" }, 500);
  }
}
