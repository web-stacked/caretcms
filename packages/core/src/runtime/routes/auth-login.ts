import type { APIContext } from "astro";
import {
  hasConfiguredEditorPassword,
  isEditorPasswordValid,
  issueEditorSessionCookie,
} from "../auth/session.js";
import { sanitizeRedirect } from "../auth/cookie-utils.js";
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  extractRateLimitKey,
  recordLoginFailure,
} from "../auth/rate-limiter.js";
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
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  };
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST(context: APIContext): Promise<Response> {
  const runtime = getRuntimeConfig();

  if (!hasConfiguredEditorPassword()) {
    return json({ error: "Editor password is not configured." }, 500);
  }

  const tooLarge = enforceContentLength(context.request, MAX_JSON_BODY_BYTES);
  if (tooLarge) return tooLarge;

  const rateLimitKey = extractRateLimitKey(context.request);
  const rateLimit = checkLoginRateLimit(rateLimitKey);
  if (!rateLimit.allowed) {
    return json(
      { error: "Too many login attempts. Please wait and try again." },
      429,
      { "Retry-After": String(rateLimit.retryAfterSeconds) },
    );
  }

  const contentType = context.request.headers.get("content-type") ?? "";
  const accept = context.request.headers.get("accept") ?? "";
  const isJsonBody = contentType.includes("application/json");
  const wantsJsonResponse = isJsonBody || accept.includes("application/json");

  let password = "";
  let redirectTo: string | null = context.url.searchParams.get("redirect");

  if (isJsonBody) {
    const body = (await context.request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    password = typeof body?.password === "string" ? body.password : "";
    redirectTo =
      typeof body?.redirect === "string" ? body.redirect : redirectTo;
  } else {
    const formData = await context.request.formData().catch(() => null);
    password =
      typeof formData?.get("password") === "string"
        ? (formData?.get("password") as string)
        : "";
    redirectTo =
      typeof formData?.get("redirect") === "string"
        ? (formData?.get("redirect") as string)
        : redirectTo;
  }

  // Default to the live site (inline editor) when no explicit redirect is given;
  // `editorHome` (default "/") makes that landing page configurable.
  const safeRedirect = sanitizeRedirect(redirectTo, runtime.editorHome);

  // Password check + session minting both derive HMACs from the session
  // secret, which throws in production when CARET_SESSION_SECRET is unset.
  // Surface that as a configuration error instead of an unhandled 500.
  let passwordValid: boolean;
  let cookie: string;
  try {
    passwordValid = isEditorPasswordValid(password);
    if (!passwordValid) {
      recordLoginFailure(rateLimitKey);
      if (wantsJsonResponse) return json({ error: "Invalid password" }, 401);
      return redirect(`${runtime.mountPath}?error=invalid`);
    }
    clearLoginAttempts(rateLimitKey);
    cookie = issueEditorSessionCookie("/", context.request);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }

  if (wantsJsonResponse) {
    return json({ ok: true, redirect: safeRedirect }, 200, { "Set-Cookie": cookie });
  }
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
