import { durableGitJournalEnabled, hasGitJournalQueue, canRetryPublicationJournals } from "../publication-journal.js";
import { getRequestContext } from "../request-context.js";
import { canPublishOverlay } from "../publish.js";
export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeServices } from "../providers.js";
import { discardOverlay, type PublishScope } from "../publish.js";
import { countPendingDrafts, draftChangeList, draftConflicts } from "../unpublished.js";
import { draftOnlyUploads, removeDiscardedUploads } from "../upload-files.js";
import { describeDraftChanges, describeDraftConflicts, json, enforceCsrfHeader, readJsonBody } from "./_helpers.js";
import { SessionOverlayAdapter } from "../storage/session-overlay-adapter.js";
import { withEntryLock } from "../mutations/engine.js";
import { requirePermission, PermissionDenied } from "../authorization.js";

/**
 * GET /api/cms/draft — report whether the current editor has unpublished drafts.
 * With `?changes=1` the reply also lists, per draft, the fields the editor
 * changed and the fields that changed on the site since the draft was started.
 */
export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);

  const editorId = getEditorId(context);
  if (!editorId) return json({ hasDrafts: false, count: 0 });

  const { adapter: base } = await getRuntimeServices();
  if (!base.makeEditorOverlay) return json({ hasDrafts: false, count: 0 });

  const overlay = await base.makeEditorOverlay(editorId);
  // Drafts that change nothing visitors see (an undone edit) aren't counted.
  const count = await countPendingDrafts(base, overlay);
  const journalPending = durableGitJournalEnabled() && hasGitJournalQueue(overlay)
    ? (await overlay.listGitJournalReceipts!()).length : 0;
  const retryJournal = journalPending > 0 && await canRetryPublicationJournals(overlay);
  const conflicts = await describeDraftConflicts(base, overlay, await draftConflicts(base, overlay));
  const changes = context.url?.searchParams.get("changes") === "1"
    ? await describeDraftChanges(base, overlay, await draftChangeList(base, overlay)) : null;
  return json({ ...(conflicts.length ? { conflicts } : {}), ...(changes ? { changes } : {}), ...(journalPending > 0 ? { retryJournal, journalPending } : {}), ...(getRequestContext()?.authorize ? { canPublish: await canPublishOverlay(overlay) } : {}), hasDrafts: count > 0, count, retryRebuild: Boolean(await overlay.getRebuildReceipt?.()) });
}

/**
 * POST /api/cms/draft — settle a draft whose fields also changed on the site.
 * Body: `{ collection, id, keep: "mine" | "site" }`. "mine" keeps the editor's
 * values (Publish then puts them on top); "site" takes the site's values for
 * the fields in conflict and keeps the editor's other changes.
 * Body: `{ collection, id, field }` takes one field of the draft back to the
 * site's value and keeps the rest.
 */
export async function POST(context: APIContext): Promise<Response> {
  const csrf = enforceCsrfHeader(context.request);
  if (csrf) return csrf;
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);
  const editorId = getEditorId(context);
  if (!editorId) return json({ error: "No editor draft session" }, 400);

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const { collection, id, keep, field } = (parsed.value ?? {}) as { collection?: unknown; id?: unknown; keep?: unknown; field?: unknown };
  const oneField = typeof field === "string" && field !== "";
  if (typeof collection !== "string" || typeof id !== "string" || (!oneField && keep !== "mine" && keep !== "site")) {
    return json({ error: "collection and id are required, with keep (\"mine\" or \"site\") or a field" }, 400);
  }

  const { adapter: base } = await getRuntimeServices();
  if (!base.makeEditorOverlay) {
    return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
  }
  const overlay = await base.makeEditorOverlay(editorId);
  try {
    await requirePermission("edit", collection, id);
    const drafts = new SessionOverlayAdapter(base, overlay);
    const settled = await withEntryLock(collection, id, () => oneField
      ? drafts.revertDraftField(collection, id, field as string)
      : drafts.resolveDraftConflict(collection, id, keep as "mine" | "site"));
    return settled ? json({ ok: true }) : json({ error: oneField ? "This draft doesn't change that field" : "This draft has no conflict to settle" }, 409);
  } catch (error) {
    if (error instanceof PermissionDenied) return json({ error: "Forbidden" }, 403);
    return json({ error: "The draft changed while it was being settled. Try again." }, 409);
  }
}

/**
 * DELETE /api/cms/draft — discard the current editor's draft(s) without
 * publishing. Optional `?collection=&id=` query scopes it to one entry or
 * collection; absent, the editor's whole draft is dropped.
 */
export async function DELETE(context: APIContext): Promise<Response> {
  const csrf = enforceCsrfHeader(context.request);
  if (csrf) return csrf;
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);

  const editorId = getEditorId(context);
  if (!editorId) return json({ error: "No editor draft session" }, 400);

  const url = new URL(context.request.url);
  const scope: PublishScope = {};
  const collection = url.searchParams.get("collection");
  const id = url.searchParams.get("id");
  if (collection) scope.collection = collection;
  if (id) scope.id = id;
  if (scope.id && !scope.collection) {
    return json({ error: "id requires a collection" }, 400);
  }

  const { adapter: base } = await getRuntimeServices();
  if (!base.makeEditorOverlay) {
    return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
  }
  const overlay = await base.makeEditorOverlay(editorId);
  try {
    // Images uploaded for these drafts and never published go with them.
    const { uploadHandler } = await getRuntimeServices();
    const targets = scope.collection && scope.id ? [{ collection: scope.collection, id: scope.id }]
      : (await Promise.all((scope.collection ? [scope.collection] : await overlay.discoverCollections())
        .map(async (name) => (await overlay.listEntryIds(name)).map((entryId) => ({ collection: name, id: entryId }))))).flat();
    const uploads = await draftOnlyUploads(uploadHandler, base, overlay, targets).catch(() => []);
    const cleared = await discardOverlay(overlay, scope);
    await removeDiscardedUploads(uploadHandler, overlay, uploads).catch(() => []);
    return json({ ok: true, cleared });
  } catch {
    return json({ error: "Some drafts require publish recovery. Retry Publish before discarding them." }, 409);
  }
}
