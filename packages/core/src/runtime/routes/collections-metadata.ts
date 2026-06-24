export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { json, resolveAdapter } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const adapter = await resolveAdapter();

  try {
    const collections = await adapter.listCollectionMetadata();
    return json({ collections });
  } catch (error) {
    // Don't echo the raw error to the client — it can carry filesystem paths
    // or other internal detail. Log it server-side, return an opaque message.
    console.error("[caretcms] Failed to load collection metadata:", error);
    return json({ error: "Failed to load collections" }, 500);
  }
}
