import { getRequestContext } from "../request-context.js";
import { canPerform } from "../authorization.js";
export const prerender = false;

import type { APIContext } from "astro";
import { getEditorId, getEditorIdentity, hasConfiguredEditorPassword, isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeServices } from "../providers.js";
import { json } from "./_helpers.js";

export async function GET(context: APIContext): Promise<Response> {
  const authenticated = isEditorAuthenticated(context);
  return json({
    ...(authenticated && getRequestContext()?.authorize ? {
      draftMode: true,
      permissions: Object.fromEntries(await Promise.all(
        (["edit", "create", "publish", "delete", "manageCollections", "upload"] as const).map(async action =>
          [action, await canPerform(action, context.url?.searchParams.get("collection") ?? undefined, context.url?.searchParams.get("id") ?? undefined)]),
      )),
    } : {}),
    authenticated,
    identity: authenticated ? getEditorIdentity(context) : null,
    // Drafts are keyed by a stable editor id (an identity's, or the shared
    // password editor's); only throwaway demo sessions lose them on sign-out.
    draftsSurviveSignOut: authenticated && !getRequestContext()?.demoMode && getEditorId(context) !== null,
    // Lets the editor offer a password field when a session ends mid-edit.
    passwordLogin: !(await getRuntimeServices()).identityAdapter && hasConfiguredEditorPassword(),
  });
}
