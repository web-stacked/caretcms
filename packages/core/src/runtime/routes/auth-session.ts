import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { json } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  return json({
    authenticated: isEditorAuthenticated(context),
  });
}
