import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { shouldUseSecureCookies } from "./cookie-utils.js";
import { getRequestContext } from "../request-context.js";

// Injected by the integration's Vite `define` during `astro dev` (empty in
// production builds). Read with a `typeof` guard so it is safe even where the
// define is absent (e.g. unit tests) — a bare reference would throw.
declare const __ASTRO_CARET_DEV_PASSWORD__: string | undefined;

// Injected by the integration's Vite `define`: true only under `astro dev`,
// false in a production build (and absent in unit tests / direct imports).
// This is the authoritative dev signal — it is baked at build time, so unlike
// NODE_ENV it is reliable on runtimes (Cloudflare Workers) that don't set
// NODE_ENV to "production". Guarded with `typeof` so a bare reference is safe.
declare const __ASTRO_CARET_DEV__: boolean | undefined;

/**
 * Read an env var from any available source. Node hosts populate `process.env`;
 * Cloudflare Workers inject bindings via `context.locals.runtime.env`, which the
 * middleware exposes on the request context. Process env wins when both are set.
 */
function readEnv(key: string): string | undefined {
  const fromProcess =
    typeof process !== "undefined" ? process.env?.[key] : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;
  const runtimeEnv = getRequestContext()?.runtimeEnv;
  const fromRuntime = runtimeEnv?.[key];
  return typeof fromRuntime === "string" ? fromRuntime : undefined;
}

/**
 * True in a dev context, where the public fallback session secret is acceptable
 * (zero-config `astro dev`). The build-time define is authoritative; when it is
 * absent (unit tests, direct imports) we fall back to NODE_ENV, defaulting to
 * dev unless it is explicitly "production". A production build bakes the define
 * to `false`, so the fallback secret is refused regardless of NODE_ENV.
 */
function isDevContext(): boolean {
  if (typeof __ASTRO_CARET_DEV__ === "boolean") return __ASTRO_CARET_DEV__;
  const nodeEnv = typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;
  return nodeEnv !== "production";
}

const SESSION_COOKIE_NAME = "caret_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  editor: true;
  exp: number;
  /**
   * A stable id minted once per login, identifying this editor session. Used to
   * key a per-editor draft overlay (so two editors' unpublished edits stay
   * isolated). Optional for backward compatibility: tokens issued before editor
   * ids existed still authenticate, they just carry no id.
   */
  editorId?: string;
};

const DEV_SECRET_FALLBACK = "caretcms-dev-secret";
let devSecretWarned = false;

function getConfiguredEditorPassword(): string | null {
  const value = readEnv("CARET_EDIT_PASSWORD") ?? readEnv("EDIT_PASSWORD") ?? "";
  return value.trim().length > 0 ? value : null;
}

// During `astro dev`, the integration generates a throwaway password and exposes
// it via the __ASTRO_CARET_DEV_PASSWORD__ define so a freshly-installed site can
// sign in without any setup. Never honored in production: the define is empty in
// a production build, and we additionally refuse it when NODE_ENV is production.
function getDevFallbackPassword(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const dev =
    typeof __ASTRO_CARET_DEV_PASSWORD__ === "string"
      ? __ASTRO_CARET_DEV_PASSWORD__
      : "";
  return dev.length > 0 ? dev : null;
}

function getEditorPassword(): string | null {
  return getConfiguredEditorPassword() ?? getDevFallbackPassword();
}

// True when the only thing unlocking the editor is the dev fallback — i.e. the
// developer hasn't set a real password yet. Drives the on-page setup hint.
export function isDevEditorPasswordActive(): boolean {
  return getConfiguredEditorPassword() === null && getDevFallbackPassword() !== null;
}

function getSessionSecret(): string {
  const configured = readEnv("CARET_SESSION_SECRET");
  if (configured && configured.trim().length > 0) return configured;

  // No secret configured. The public fallback is a known constant, so any token
  // signed with it is forgeable — it is ONLY safe in a dev context. A production
  // build refuses it and fails closed, regardless of whether a password is set:
  //  - no password  → the editor is meant to be locked; minting a session signed
  //    with a public secret would make that "locked" state fully writable (S1).
  //  - password set  → the operator must supply a real secret.
  // In both cases we throw here; `trySignPayload` catches it so verification just
  // returns "not an editor" rather than 500-ing every request.
  if (isDevContext()) {
    // Warn only once, and only when a real password is configured — that's the
    // "you set a password, now set a secret" nudge. Zero-config dev (no password)
    // stays silent.
    if (getConfiguredEditorPassword() !== null && !devSecretWarned) {
      devSecretWarned = true;
      console.warn(
        "[caretcms] CARET_SESSION_SECRET is unset; using a public dev fallback. " +
          "Set CARET_SESSION_SECRET before exposing this site to the network.",
      );
    }
    return DEV_SECRET_FALLBACK;
  }

  throw new Error(
    "[caretcms] CARET_SESSION_SECRET is required in production. " +
      "Generate one with `openssl rand -base64 32` and set it in your environment.",
  );
}

function signPayload(payloadB64: string): string {
  return createHmac("sha256", getSessionSecret()).update(payloadB64).digest("base64url");
}

let secretErrorLogged = false;

/**
 * The missing-secret misconfiguration must hard-fail where a session is MINTED
 * (login) — but it must not take the whole site down: the pre-middleware checks
 * every request that carries a `caret_session` cookie, so an unguarded throw
 * here turns one missing env var into a 500 on every page for every visitor
 * with a stale cookie. Verification therefore fails closed ("not an editor")
 * and logs the cause once for the operator.
 */
function trySignPayload(payloadB64: string): string | null {
  try {
    return signPayload(payloadB64);
  } catch (err) {
    if (!secretErrorLogged) {
      secretErrorLogged = true;
      console.error(
        `${(err as Error).message} Editor sessions are disabled until it is set.`,
      );
    }
    return null;
  }
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

  const expected = trySignPayload(payloadB64);
  if (expected === null) return null;
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
    // editorId is optional (legacy tokens lack it), but reject a malformed one.
    if (payload.editorId !== undefined && typeof payload.editorId !== "string") return null;

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
  const token = buildToken({ editor: true, exp, editorId: randomUUID() });
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
  // the request-scoped ALS context before this check runs. We require
  // `overlayActive` too: without an installed per-session overlay, writes
  // would land in the shared base store, so granting editor rights would be
  // an unauthenticated-write hole. Fail closed when the overlay is absent.
  const ctx = getRequestContext();
  if (ctx?.demoMode && ctx.sessionId && ctx.overlayActive) return true;

  const token = context.cookies?.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return false;
  return parseToken(token) !== null;
}

/**
 * The per-editor id carried by the session cookie, used to key a draft overlay.
 * Returns null when the request has no valid editor session, or when the session
 * predates editor ids (a legacy token). Does NOT consider demo sessions — those
 * are keyed by their own `sessionId`.
 */
export function getEditorId(context: CookieBagLike): string | null {
  const token = context.cookies?.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return parseToken(token)?.editorId ?? null;
}
