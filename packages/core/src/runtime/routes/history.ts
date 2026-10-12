import { parseFrontmatter } from "../storage/frontmatter-codec.js";
import { sameContent } from "../draft-state.js";
import { PUBLISH_RECOVERY_KEY } from "../draft-state.js";
import { recoveryState, resumePublish, RecoveryConflict, type PublishRecovery } from "../publish-recovery.js";
import { validateEntryTransition, EntryValidationError } from "../entry-validation.js";
import { readAdapterSnapshot } from "../storage/read-snapshot.js";
import { canPerform } from "../authorization.js";
import { getRequestContext } from "../request-context.js";
import { getRuntimeServices } from "../providers.js";
export const prerender = false;

import type { APIContext } from "astro";
import { getEditorId, getEditorIdentity, isEditorAuthenticated } from "../auth/session.js";
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

  // Mark the requester's own snapshots so the Studio can say "You" when an
  // editor has no name or email (password sessions only carry an opaque id).
  const editorId = getEditorId(context);
  const history = (await adapter.getHistory(collectionRaw, id)).map((item) =>
    editorId && item.editor?.id === editorId ? { ...item, editor: { ...item.editor, current: true } } : item);
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
    const editorId = getEditorId(context);
    const restored = await withEntryLock(collectionRaw, id, async () => {
      const recovery = adapter.writeBodySource && adapter.makeRecoveryOverlay && editorId
        ? await adapter.makeRecoveryOverlay(editorId, "source-restore") : null;
      const pending = recovery ? await readAdapterSnapshot(recovery, collectionRaw, id) : null;
      if (pending?.entry) {
        const plan = recoveryState(pending.entry.data);
        if (!plan || plan.afterData === null || typeof plan.afterSource !== "string" ||
            plan.history.action !== "restore" || pending.entry.data.requestedTs !== ts) {
          throw new RecoveryConflict("Finish the interrupted restore before restoring another snapshot");
        }
        const sourceData = parseFrontmatter(plan.afterSource);
        if (!sourceData.ok || !sameContent(sourceData.data, plan.afterData)) throw new RecoveryConflict("Restore source snapshot is inconsistent");
        const revision = await resumePublish(adapter, recovery!, collectionRaw, id, plan);
        return { revision, data: plan.afterData! };
      }
      const entries = await adapter.getHistory(collectionRaw, id);
      const snapshot = entries.find(entry => entry.ts === ts);
      if (!snapshot) return { response: json({ error: "Snapshot not found" }, 404) };
      if (!snapshot.data || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)) {
        return { response: json({ error: "Snapshot data invalid" }, 500) };
      }
      const snapshotData = snapshot.data as Record<string, unknown>;
      const issues = await validateEntryTransition(adapter, collectionRaw, snapshotData);
      if (issues.length) return { issues };
      const current = await readAdapterSnapshot(adapter, collectionRaw, id);
      const beforeRevision = current.revision;
      const before = current.entry;
      // A publish snapshot that spliced body blocks carries the full
      // pre-publish source file — restore that exact file (prose + frontmatter
      // formatting). Its frontmatter already represents snapshotData, so a
      // follow-up writeEntry would only reserialize it and destroy byte parity.
      if (typeof snapshot.bodySource === "string" && adapter.writeBodySource) {
        const sourceData = parseFrontmatter(snapshot.bodySource);
        if (!sourceData.ok || !sameContent(sourceData.data, snapshotData)) {
          return { issues: [{ path: "", code: "invalid_source", message: "Snapshot source does not match its entry data" }] };
        }
        if (!recovery || !adapter.readBodySource || !editorId) {
          return { response: json({ error: "Source restore requires private durable recovery storage" }, 400) };
        }
        const currentSource = await adapter.readBodySource(collectionRaw, id);
        if (currentSource === snapshot.bodySource && sameContent(before?.data, snapshotData)) {
          return { revision: beforeRevision, data: snapshotData };
        }
        const plan: PublishRecovery = {
          version: 1, beforeRevision, beforeData: before?.data ?? null, afterData: snapshotData,
          ...(typeof currentSource === "string" ? { beforeSource: currentSource } : {}),
          afterSource: snapshot.bodySource,
          history: { operationId: crypto.randomUUID(), ts: Date.now(), action: "restore",
            data: before?.data ?? null,
            ...(typeof currentSource === "string" ? { bodySource: currentSource } : {}),
            ...(editor ? { editor } : {}) },
        };
        const persisted = await commitEntryChanges(recovery, [{ collection: collectionRaw, id,
          expectedRevision: pending?.revision ?? 0, expectedExists: false,
          data: { requestedTs: ts, [PUBLISH_RECOVERY_KEY]: plan } }]);
        if (!persisted.ok) throw new RecoveryConflict("Restore recovery state changed");
        const revision = await resumePublish(adapter, recovery, collectionRaw, id, plan);
        return { revision, data: snapshotData };
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

    if ("response" in restored) return restored.response!;
    if ("issues" in restored) return json({ error: "Snapshot does not match current collection requirements", issues: restored.issues }, 400);
    return json({ ok: true, revision: restored.revision, data: restored.data });
  } catch (error) {
    // An adapter throw must not leak a stack/path via a framework 500.
    if (error instanceof EntryValidationError) return json({ error: "Snapshot does not match current collection requirements", issues: error.issues }, 400);
    if (error instanceof RecoveryConflict) return json({ error: "Restore recovery conflicts with current content or a different pending snapshot. Retry the original snapshot after resolving the conflict." }, 409);
    console.error("[caretcms] History restore failed:", error);
    return json({ error: "Restore could not finish. Retry the same snapshot to recover." }, 500);
  }
}
