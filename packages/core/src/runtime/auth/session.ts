import { createHmac, timingSafeEqual } from "crypto";
import { shouldUseSecureCookies } from "./cookie-utils.js";
import { getRequestContext } from "../request-context.js";

const SESSION_COOKIE_NAME = "caret_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  editor: true;
  exp: number;
};

const DEV_SECRET_FALLBACK = "caretcms-dev-secret";
let devSecretWarned = false;

function getEditorPassword(): string | null {
  const value = process.env.CARET_EDIT_PASSWORD ?? process.env.EDIT_PASSWORD ?? "";
  return value.trim().length > 0 ? value : null;
}

function getSessionSecret(): string {
  const configured = process.env.CARET_SESSION_SECRET;
  if (configured && configured.trim().length > 0) return configured;

  // No secret configured. Safe to fall back only when the CMS is effectively
  // disabled (no editor password). Once a password is set, the dev fallback
  // is a known string that lets anyone forge a session — refuse it in
  // production and warn loudly in dev.
  if (getEditorPassword() === null) return DEV_SECRET_FALLBACK;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[caretcms] CARET_SESSION_SECRET is required in production when CARET_EDIT_PASSWORD is set. " +
        "Generate one with `openssl rand -base64 32` and set it in your environment.",
    );
  }

  if (!devSecretWarned) {
    devSecretWarned = true;
    console.warn(
      "[caretcms] CARET_SESSION_SECRET is unset; using a public dev fallback. " +
        "Set CARET_SESSION_SECRET before exposing this site to the network.",
    );
  }
  return DEV_SECRET_FALLBACK;
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", getSessionSecret()).update(payloadB64).digest("base64url");
}

function serializeEditorSessionCookie(
  value: string,
  path: string,
  maxAge: number,
  request?: Request,
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];

  if (shouldUseSecureCookies(request)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function buildToken(payload: SessionPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signPayload(payloadB64);
  return `${payloadB64}.${sig}`;
}

function parseToken(token: string): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return null;

  const expected = signPayload(payloadB64);
  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, "base64url");
    expectedBuf = Buffer.from(expected, "base64url");
  } catch {
    return null;
  }
  if (sigBuf.length === 0 || sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const payload = parsed as Record<string, unknown>;
    if (payload.editor !== true) return null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    if (payload.exp <= Date.now()) return null;

    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export function isEditorPasswordValid(candidate: string): boolean {
  const expected = getEditorPassword();
  if (!expected) return false;
  if (!candidate) return false;

  // Hash both sides to fixed-length digests so the comparison cannot leak
  // the configured password's length through a length-mismatch shortcut.
  const secret = getSessionSecret();
  const candidateDigest = createHmac("sha256", secret).update(candidate).digest();
  const expectedDigest = createHmac("sha256", secret).update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export function issueEditorSessionCookie(path = "/", request?: Request): string {
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  const token = buildToken({ editor: true, exp });
  return serializeEditorSessionCookie(
    encodeURIComponent(token),
    path,
    SESSION_TTL_SECONDS,
    request,
  );
}

export function clearEditorSessionCookie(path = "/", request?: Request): string {
  return serializeEditorSessionCookie("", path, 0, request);
}

export function hasConfiguredEditorPassword(): boolean {
  return getEditorPassword() !== null;
}

type CookieBagLike = {
  cookies?: {
    get: (name: string) => { value: string } | undefined;
  };
};

export function isEditorAuthenticated(context: CookieBagLike): boolean {
  // Demo mode: any visitor with a resolved sandbox session is an editor of
  // their own private overlay. Middleware sets `demoMode` + `sessionId` in
  // the request-scoped ALS context before this check runs.
  const ctx = getRequestContext();
  if (ctx?.demoMode && ctx.sessionId) return true;

  const token = context.cookies?.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return false;
  return parseToken(token) !== null;
}
