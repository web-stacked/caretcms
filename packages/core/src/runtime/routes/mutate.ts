import { getRequestContext } from "../request-context.js";
export const prerender = false;

import type { APIContext } from "astro";
import type { StorageAdapter } from "../../types.js";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { executeMutation, type MutationOptions } from "../mutations/engine.js";
import { getRuntimeServices } from "../providers.js";
import { SessionOverlayAdapter } from "../storage/session-overlay-adapter.js";
import { json, resolveAdapter, enforceCsrfHeader, readJsonBody } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();

  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  return json({
    ok: true,
    route: `${runtime.apiBasePath}/mutate`,
    methods: ["POST"],
    note: "Mutation pipeline is active. Use POST with a mutation command payload.",
  });
}

export async function POST(context: APIContext): Promise<Response> {
  const csrfFailure = enforceCsrfHeader(context.request);
  if (csrfFailure) return csrfFailure;

  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const parsed = await readJsonBody(context.request);
  if (!parsed.ok) return parsed.response;

  // Body-block edits are ALWAYS drafts, independent of the preview cookie that
  // routes other mutations through the overlay: written through the base
  // markdown adapter they'd be serialized into frontmatter. Build the editor's
  // persistent draft overlay explicitly, exactly like the publish route does.
  const isMdBlock =
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    (parsed.value as { type?: unknown }).type === "md_block";

  let adapter: StorageAdapter;
  let options: MutationOptions | undefined;
  if (isMdBlock) {
    const editorId = getEditorId(context);
    if (!editorId) return json({ error: "No editor draft session" }, 400);
    const services = await getRuntimeServices();
    const base = services.adapter;
    if (!base.makeEditorOverlay) {
      return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
    }
    adapter = new SessionOverlayAdapter(base, await base.makeEditorOverlay(editorId));
    options = { allowedClasses: services.allowedClasses };
  } else {
    const type = (parsed.value as { type?: unknown } | null)?.type;
    adapter = getRequestContext()?.authorize && (type === "create_collection" || type === "delete_collection")
      ? (await getRuntimeServices()).adapter : await resolveAdapter();
  }

  try {
    const result = await executeMutation(adapter, parsed.value, options);
    if (!result.ok) {
      return json(result.body as Record<string, unknown>, result.status);
    }
    return json(result.body as Record<string, unknown>, 200);
  } catch (error) {
    // An adapter throw (full/read-only disk, KV outage) must surface as a
    // curated JSON error, not a framework 500 that can leak a stack or a
    // filesystem path. Log server-side, return an opaque message.
    console.error("[caretcms] Mutation failed:", error);
    return json({ error: "Mutation failed" }, 500);
  }
}
