import { getRequestContext } from "../request-context.js";
import { canPerform } from "../authorization.js";
export const prerender = false;

import type { APIContext } from "astro";
import { getEditorIdentity, isEditorAuthenticated } from "../auth/session.js";
import { json } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  const authenticated = isEditorAuthenticated(context);
  return json({
    ...(authenticated && getRequestContext()?.authorize ? {
      draftMode: true,
      permissions: Object.fromEntries(await Promise.all(
        (["edit", "publish", "delete", "manageCollections", "upload"] as const).map(async action =>
          [action, await canPerform(action, context.url?.searchParams.get("collection") ?? undefined, context.url?.searchParams.get("id") ?? undefined)]),
      )),
    } : {}),
    authenticated,
    identity: authenticated ? getEditorIdentity(context) : null,
    draftsSurviveSignOut: authenticated && Boolean(
      getRequestContext()?.identityAuthoritative && getRequestContext()?.identity?.id,
    ),
  });
}
