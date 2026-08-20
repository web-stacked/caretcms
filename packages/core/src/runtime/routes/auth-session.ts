export const prerender = false;

import type { APIContext } from "astro";
import { getEditorIdentity, isEditorAuthenticated } from "../auth/session.js";
import { json } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  const authenticated = isEditorAuthenticated(context);
  return json({
    authenticated,
    identity: authenticated ? getEditorIdentity(context) : null,
  });
}
