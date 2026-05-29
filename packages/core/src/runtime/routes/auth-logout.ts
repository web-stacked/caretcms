import type { APIContext } from "astro";
import { clearEditorSessionCookie } from "../auth/session.js";
import { sanitizeRedirect } from "../auth/cookie-utils.js";
import { getRuntimeConfig } from "../config.js";
import { enforceContentLength, MAX_JSON_BODY_BYTES } from "./_helpers.js";

function redirect(pathname: string, setCookie?: string): Response {
  const headers: Record<string, string> = { Location: pathname };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}

function json(
  body: Record<string, unknown>,
  status = 200,
  setCookie?: string,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST(context: APIContext): Promise<Response> {
  const tooLarge = enforceContentLength(context.request, MAX_JSON_BODY_BYTES);
  if (tooLarge) return tooLarge;

  const runtime = getRuntimeConfig();
  const contentType = context.request.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const cookie = clearEditorSessionCookie("/", context.request);
  let redirectTo: string | null = context.url.searchParams.get("redirect");

  if (isJson) {
    const body = (await context.request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    redirectTo =
      typeof body?.redirect === "string" ? body.redirect : redirectTo;
  } else {
    const formData = await context.request.formData().catch(() => null);
    redirectTo =
      typeof formData?.get("redirect") === "string"
        ? (formData?.get("redirect") as string)
        : redirectTo;
  }

  const safeRedirect = sanitizeRedirect(redirectTo, runtime.mountPath);

  if (isJson) return json({ ok: true, redirect: safeRedirect }, 200, cookie);
  return redirect(safeRedirect, cookie);
}

export async function GET(): Promise<Response> {
  return json(
    {
      error: "Method not allowed",
      allowedMethods: ["POST"],
    },
    405,
  );
}
