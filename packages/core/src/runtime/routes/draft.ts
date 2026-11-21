import { durableGitJournalEnabled, hasGitJournalQueue, canRetryPublicationJournals } from "../publication-journal.js";
import { getRequestContext } from "../request-context.js";
import { canPublishOverlay } from "../publish.js";
export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeServices } from "../providers.js";
import { discardOverlay, type PublishScope } from "../publish.js";
import { countPendingDrafts, draftConflicts } from "../unpublished.js";
import { describeDraftConflicts, json, enforceCsrfHeader, readJsonBody } from "./_helpers.js";
import { SessionOverlayAdapter } from "../storage/session-overlay-adapter.js";
import { withEntryLock } from "../mutations/engine.js";
import { requirePermission, PermissionDenied } from "../authorization.js";

/**
 * GET /api/cms/draft — report whether the current editor has unpublished drafts.
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
  return json({ ...(conflicts.length ? { conflicts } : {}), ...(journalPending > 0 ? { retryJournal, journalPending } : {}), ...(getRequestContext()?.authorize ? { canPublish: await canPublishOverlay(overlay) } : {}), hasDrafts: count > 0, count, retryRebuild: Boolean(await overlay.getRebuildReceipt?.()) });
}

/**
 * POST /api/cms/draft — settle a draft whose fields also changed on the site.
 * Body: `{ collection, id, keep: "mine" | "site" }`. "mine" keeps the editor's
 * values (Publish then puts them on top); "site" takes the site's values for
 * the fields in conflict and keeps the editor's other changes.
 */
export async function POST(context: APIContext): Promise<Response> {
  const csrf = enforceCsrfHeader(context.request);
  if (csrf) return csrf;
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);
  const editorId = getEditorId(context);
  if (!editorId) return json({ error: "No editor draft session" }, 400);

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const { collection, id, keep } = (parsed.value ?? {}) as { collection?: unknown; id?: unknown; keep?: unknown };
  if (typeof collection !== "string" || typeof id !== "string" || (keep !== "mine" && keep !== "site")) {
    return json({ error: "collection, id and keep (\"mine\" or \"site\") are required" }, 400);
  }

  const { adapter: base } = await getRuntimeServices();
  if (!base.makeEditorOverlay) {
    return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
  }
  const overlay = await base.makeEditorOverlay(editorId);
  try {
    await requirePermission("edit", collection, id);
    const settled = await withEntryLock(collection, id, () =>
      new SessionOverlayAdapter(base, overlay).resolveDraftConflict(collection, id, keep));
    return settled ? json({ ok: true }) : json({ error: "This draft has no conflict to settle" }, 409);
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
    const cleared = await discardOverlay(overlay, scope);
    return json({ ok: true, cleared });
  } catch {
    return json({ error: "Some drafts require publish recovery. Retry Publish before discarding them." }, 409);
  }
}
