import type { APIContext } from "astro";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeServices } from "../providers.js";
import { publishOverlay, type PublishScope } from "../publish.js";
import { json, enforceCsrfHeader, readJsonBody } from "./_helpers.js";

/**
 * POST /api/cms/publish — flush the current editor's draft overlay into the base.
 * Body: `{ collection?, id? }` to scope to one entry/collection, or `{}` for all.
 * Returns the published entries with their NEW base revisions so the editor
 * client can reconcile its revision cache (avoiding a post-publish 409).
 */
export async function POST(context: APIContext): Promise<Response> {
  const csrf = enforceCsrfHeader(context.request);
  if (csrf) return csrf;
  if (!isEditorAuthenticated(context)) return json({ error: "Unauthorized" }, 401);

  const editorId = getEditorId(context);
  if (!editorId) return json({ error: "No editor draft session" }, 400);

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.value ?? {}) as { collection?: unknown; id?: unknown };

  const scope: PublishScope = {};
  if (typeof body.collection === "string") scope.collection = body.collection;
  if (typeof body.id === "string") scope.id = body.id;
  if (scope.id && !scope.collection) {
    return json({ error: "id requires a collection" }, 400);
  }

  const { adapter: base } = await getRuntimeServices();
  if (!base.makeEditorOverlay) {
    return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
  }
  const overlay = await base.makeEditorOverlay(editorId);
  const published = await publishOverlay(base, overlay, scope);
  return json({ ok: true, published });
}
