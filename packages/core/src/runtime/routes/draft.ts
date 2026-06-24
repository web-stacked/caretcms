export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeServices } from "../providers.js";
import { countOverlayDrafts, discardOverlay, type PublishScope } from "../publish.js";
import { json, enforceCsrfHeader } from "./_helpers.js";

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
  const count = await countOverlayDrafts(overlay);
  return json({ hasDrafts: count > 0, count });
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
  const cleared = await discardOverlay(overlay, scope);
  return json({ ok: true, cleared });
}
