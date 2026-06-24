export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { getRuntimeConfig } from "../config.js";
import { executeMutation } from "../mutations/engine.js";
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

  const adapter = await resolveAdapter();
  const result = await executeMutation(adapter, parsed.value);
  if (!result.ok) {
    return json(result.body as Record<string, unknown>, result.status);
  }
  return json(result.body as Record<string, unknown>, 200);
}
