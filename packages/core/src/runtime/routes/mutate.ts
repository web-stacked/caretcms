import { getRequestContext } from "../request-context.js";
export const prerender = false;

import type { APIContext } from "astro";
import type { StorageAdapter } from "../../types.js";
import { isEditorAuthenticated, getEditorId } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { executeMutation, withEditorPublishLock, type MutationOptions } from "../mutations/engine.js";
import { discardOverlay, publishOverlay } from "../publish.js";
import { contentWithoutState } from "../draft-state.js";
import { BODY_OVERLAY_KEY } from "../../markdown/contracts.js";
import { waitForSelfWriteReload } from "../self-writes.js";
import { getRuntimeServices } from "../providers.js";
import { SessionOverlayAdapter } from "../storage/session-overlay-adapter.js";
import { json, resolveAdapter, enforceCsrfHeader, readJsonBody } from "./_helpers.js";

declare const __ASTRO_CARET_DEV__: boolean | undefined;
const isDev = typeof __ASTRO_CARET_DEV__ === "boolean" && __ASTRO_CARET_DEV__;

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

  // Body-block edits are always stored as drafts first: written through the
  // base markdown adapter they'd be serialized into frontmatter. Build the
  // editor's persistent draft overlay explicitly, exactly like the publish
  // route does. Where field edits save live, the draft is published straight
  // away (below), so body and fields on one page save the same way.
  const isMdBlock =
    typeof parsed.value === "object" &&
    parsed.value !== null &&
    (parsed.value as { type?: unknown }).type === "md_block";

  let adapter: StorageAdapter;
  let options: MutationOptions | undefined;
  /** Set when this body edit should go live as soon as it's stored. */
  let publishNow: (() => Promise<boolean>) | null = null;
  /** Drops the body draft once its edits are all taken back (an Undo, say);
   *  true when nothing is left to publish. */
  let dropEmptyDraft: (() => Promise<boolean>) | null = null;
  if (isMdBlock) {
    const editorId = getEditorId(context);
    if (!editorId) return json({ error: "No editor draft session" }, 400);
    const services = await getRuntimeServices();
    const base = services.adapter;
    if (!base.makeEditorOverlay) {
      return json({ error: "Drafts are not supported by the configured storage adapter" }, 400);
    }
    const overlay = await base.makeEditorOverlay(editorId);
    adapter = new SessionOverlayAdapter(base, overlay);
    options = { allowedClasses: services.allowedClasses };
    // Live only where fields save live (no draft overlay for this request) and
    // the page re-renders from the file without a build: the dev server.
    const { collection, id } = parsed.value as { collection?: unknown; id?: unknown };
    if (typeof collection === "string" && typeof id === "string") {
      dropEmptyDraft = async () => {
        const draft = await overlay.getEntry(collection, id);
        if (!draft) return true;
        const content = contentWithoutState(draft.data);
        const keys = Object.keys(content);
        const body = content[BODY_OVERLAY_KEY];
        if (keys.length === 1 && keys[0] === BODY_OVERLAY_KEY && body && typeof body === "object" &&
            Object.keys(body).length === 0) {
          await discardOverlay(overlay, { collection, id });
          return true;
        }
        return false;
      };
    }
    if (isDev && !getRequestContext()?.overlayActive && typeof collection === "string" && typeof id === "string") {
      publishNow = async () => {
        // Registered before writing, so Astro's signal can't arrive first.
        const contentReady = waitForSelfWriteReload(3_000);
        const outcome = await withEditorPublishLock(editorId, () =>
          publishOverlay(base, overlay, { collection, id }));
        const live = outcome.published.some(entry => entry.collection === collection && entry.id === id);
        // Answer once the page renders the new file, so the editor can read
        // fresh block positions from it.
        if (live) await contentReady;
        return live;
      };
    }
  } else {
    const type = (parsed.value as { type?: unknown } | null)?.type;
    adapter = !getRequestContext()?.demoMode && (type === "create_collection" || type === "delete_collection")
      ? (await getRuntimeServices()).adapter : await resolveAdapter();
  }

  try {
    const result = await executeMutation(adapter, parsed.value, options);
    if (!result.ok) {
      return json(result.body as Record<string, unknown>, result.status);
    }
    const nothingPending = (await dropEmptyDraft?.()) ?? false;
    // A failed publish keeps the draft: the toolbar offers Publish for it.
    if (publishNow) {
      const live = nothingPending || await publishNow();
      return json({ ...(result.body as Record<string, unknown>), live }, 200);
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
