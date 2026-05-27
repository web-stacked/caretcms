import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { json, getAdapter } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const adapter = getAdapter();

  try {
    const collections = await adapter.listCollectionMetadata();
    return json({ collections });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load collections";
    return json({ error: message }, 500);
  }
}
