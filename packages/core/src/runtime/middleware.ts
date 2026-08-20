import type { EditorIdentity, IdentityAdapter, StorageAdapter, UploadHandler } from "../types.js";
import { isEditorAuthenticated, getEditorId } from "./auth/session.js";
import { isDemoModeEnabled, resolveDemoSession } from "./auth/demo-session.js";
import { getRuntimeServices } from "./providers.js";
import { runWithRequestContext } from "./request-context.js";
import { rewriteCaretAttributes } from "./rewrite.js";
import { hasStega, stegaClean } from "./stega.js";
import { SessionOverlayAdapter } from "./storage/session-overlay-adapter.js";
import { EDITOR_ID_RE } from "./storage/id-contracts.js";

// Side-effect import: registers any user-provided schemas into the schema registry
import "virtual:caretcms/schemas";

type MiddlewareContext = {
  locals: Record<string, unknown>;
  cookies?: {
    get: (name: string) => { value: string } | undefined;
  };
  request?: Request;
};

let _cachedRuntimeEnv: Record<string, unknown> | null | undefined;
let _overlayWarned = false;

function warnMissingOverlay(): void {
  if (_overlayWarned) return;
  _overlayWarned = true;
  console.warn(
    "[caretcms] CARET_DEMO_MODE is on but the configured storage adapter does " +
      "not implement makeSessionOverlay. Demo editor access is disabled to " +
      "avoid unauthenticated writes to shared storage. Use an adapter with " +
      "session-overlay support (e.g. the filesystem or Cloudflare KV adapters).",
  );
}

const PREVIEW_COOKIE = "caret_preview";

/** Rendered binding attributes: `data-caret="…"` / `data-caret-scope="…"`.
 *  Matches the attribute grammar the rewrite engine consumes (whitespace
 *  around `=` tolerated), so prose mentions of "data-caret" don't count. */
const BINDING_PROBE_RE = /\bdata-caret(?:-scope)?\s*=\s*"/;

/** Is this request for a CMS-owned route (Studio, API, or editor assets)? Those
 *  pages are infrastructure, so the authed empty-state hint must never show on
 *  them — only on the live site. Conservative: if the path can't be read, treat
 *  it as owned (skip the hint). */
function isCmsOwnedPath(
  context: MiddlewareContext,
  mountPath: string,
  apiBasePath: string,
): boolean {
  const url = context.request?.url;
  if (!url) return true;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  return (
    pathname === mountPath ||
    pathname.startsWith(`${mountPath}/`) ||
    pathname.startsWith(apiBasePath) ||
    pathname.startsWith("/__caret")
  );
}

/** Inject the authenticated empty-state hint before `</body>` (falls back to
 *  appending). The markup is static — the only interpolation is the normalized,
 *  config-controlled mount path — so no escaping is required. */
function injectSigninHint(html: string, mountPath: string): string {
  const snippet =
    `<link rel="stylesheet" href="/__caret/signin-hint.css">` +
    `<div class="caret-signin-hint" role="status">` +
    `<span class="caret-signin-hint__dot" aria-hidden="true"></span>` +
    `<span class="caret-signin-hint__text">Signed in · no editable fields on this page. ` +
    `Run <code>npx @caretcms/caretize</code> to add some, or <a href="${mountPath}/cms">open the Studio</a>.` +
    `</span></div>`;
  const closeBody = html.toLowerCase().lastIndexOf("</body>");
  if (closeBody === -1) return html + snippet;
  return html.slice(0, closeBody) + snippet + html.slice(closeBody);
}

/** Whether this request opted into draft preview (the editor toggles a cookie).
 *  Only meaningful for an authenticated editor — the overlay install also
 *  requires a valid editor id. */
function isPreviewRequest(context: MiddlewareContext): boolean {
  return context.cookies?.get(PREVIEW_COOKIE)?.value === "1";
}

async function resolveRuntimeEnv(): Promise<Record<string, unknown> | null> {
  if (_cachedRuntimeEnv !== undefined) return _cachedRuntimeEnv;
  try {
    const moduleId = "cloudflare:workers";
    const mod = (await import(/* @vite-ignore */ moduleId)) as {
      env?: Record<string, unknown>;
    };
    _cachedRuntimeEnv = mod.env ?? null;
  } catch {
    _cachedRuntimeEnv = null;
  }
  return _cachedRuntimeEnv;
}

type MiddlewareNext = () => Promise<Response>;

async function authenticateIdentity(
  adapter: IdentityAdapter | null,
  request: Request,
): Promise<EditorIdentity | null> {
  if (!adapter) return null;
  try {
    const identity = await adapter.authenticate(request);
    if (!identity) return null;
    if (!EDITOR_ID_RE.test(identity.id)) {
      console.error("[caretcms] Identity adapter returned an unsafe editor id; access denied.");
      return null;
    }
    return {
      id: identity.id,
      ...(typeof identity.name === "string" ? { name: identity.name } : {}),
      ...(typeof identity.email === "string" ? { email: identity.email } : {}),
      ...(Array.isArray(identity.roles)
        ? { roles: identity.roles.filter((role): role is string => typeof role === "string") }
        : {}),
    };
  } catch (error) {
    console.error("[caretcms] Identity adapter authentication failed; access denied.", error);
    return null;
  }
}

export async function onRequest(
  context: MiddlewareContext,
  next: MiddlewareNext,
): Promise<Response> {
  const services = await getRuntimeServices();
  const runtimeEnv = await resolveRuntimeEnv();
  const request = context.request ?? new Request("http://localhost/");

  let adapter: StorageAdapter = services.adapter;
  let uploadHandler: UploadHandler = services.uploadHandler;
  let sessionId: string | null = null;
  let editorId: string | null = null;
  let setCookieHeader: string | null = null;
  let overlayActive = false;
  const demoMode = isDemoModeEnabled(runtimeEnv);
  const identity = demoMode
    ? null
    : await authenticateIdentity(services.identityAdapter, request);
  if (identity) editorId = identity.id;
  else if (!demoMode && !services.identityAdapter) {
    editorId = getEditorId(context as Parameters<typeof getEditorId>[0]);
  }

  if (demoMode) {
    const resolution = resolveDemoSession(context, request);
    sessionId = resolution.sessionId;
    setCookieHeader = resolution.setCookieHeader;

    if (services.adapter.makeSessionOverlay) {
      const overlay = await services.adapter.makeSessionOverlay(sessionId);
      adapter = new SessionOverlayAdapter(services.adapter, overlay);
      overlayActive = true;
    } else {
      warnMissingOverlay();
    }

    if (services.uploadHandler.makeSessionWrapper) {
      uploadHandler = await services.uploadHandler.makeSessionWrapper(sessionId);
    }
  } else if (isPreviewRequest(context) && services.adapter.makeEditorOverlay) {
    // Draft/preview mode: an authenticated editor opting into preview reads and
    // writes through their per-editor overlay (the public site keeps seeing the
    // base). Keyed by the editor id from the session cookie; absent that (an
    // unauthenticated preview request), there's no editor session so we leave the
    // base adapter in place. Publish later flushes the overlay back to the base.
    const id = identity?.id
      ?? (services.identityAdapter ? null : getEditorId(context as Parameters<typeof getEditorId>[0]));
    if (id) {
      const overlay = await services.adapter.makeEditorOverlay(id);
      adapter = new SessionOverlayAdapter(services.adapter, overlay);
      overlayActive = true;
      editorId = id;
    }
  }

  const requestContext = {
    adapter,
    uploadHandler,
    sessionId,
    editorId,
    identity,
    identityAuthoritative: services.identityAdapter !== null,
    demoMode,
    overlayActive,
    runtimeEnv,
    editor: false,
  };

  return runWithRequestContext(requestContext, async () => {
    const isEditor = isEditorAuthenticated(
      context as Parameters<typeof isEditorAuthenticated>[0],
    );
    // Demo-overlay editor status depends on the request context (demoMode +
    // overlayActive), so it can only be resolved here, inside the ALS scope.
    // Mutate the live context object so the loaders see the gate during render.
    requestContext.editor = isEditor;
    context.locals.isEditor = isEditor;
    context.locals.caretIdentity = identity;
    const inner = await next();

    const contentType = inner.headers.get("content-type") ?? "";
    const contentEncoding = inner.headers.get("content-encoding") ?? "";
    // Skip compressed bodies — calling .text() on a gzip/brotli stream
    // returns binary garbage, which then either fails the data-caret probe
    // (silent corruption) or injects rewrites into a non-text payload.
    // Identity / empty are the only encodings safe to decode as text.
    const isIdentity = contentEncoding === "" || contentEncoding.toLowerCase() === "identity";
    const isHtml = contentType.includes("text/html") && isIdentity;

    let body: BodyInit | null = inner.body;
    let bodyConsumed = false;
    let rewritten = false;

    if (isHtml) {
      let html = await inner.text();
      bodyConsumed = true;
      // Probe for ATTRIBUTE syntax, not the bare substring: a page that merely
      // mentions data-caret in prose (docs, a blog post about the CMS) must not
      // run the rewrite engine or suppress the signed-in empty-state hint.
      // data-caret-rich is a bare attribute but always accompanies data-caret,
      // so the two valued forms cover every binding the engine can act on.
      const hasBindings = BINDING_PROBE_RE.test(html);
      if (hasBindings) {
        // An authenticated editor in server delivery reads live base content
        // (field edits save straight through), but their inline BODY-block
        // edits are always deferred drafts. Preview those on the editor's own
        // requests so a reload shows staged prose instead of silently
        // reverting to the source. ONLY the rewrite needs the overlay — it
        // injects the drafted `__body` HTML into stamped blocks — so loaders
        // and field writes keep using the base adapter and "changes save
        // directly" still holds. Demo/preview already overlay everything via
        // `adapter`; the public (editor === false) always reads the base.
        let rewriteAdapter = adapter;
        if (!overlayActive && requestContext.editor && services.adapter.makeEditorOverlay) {
          const id = editorId ?? getEditorId(context as Parameters<typeof getEditorId>[0]);
          if (id) {
            rewriteAdapter = new SessionOverlayAdapter(
              services.adapter,
              await services.adapter.makeEditorOverlay(id),
            );
          }
        }
        html = await rewriteCaretAttributes(html, rewriteAdapter, {
          allowedClasses: services.allowedClasses,
        });
        rewritten = true;
      }
      // Backstop: strip stega metadata from published output so non-editors
      // never receive the invisible characters, even if a value was encoded
      // outside the loader's editor gate. Editors keep it — the overlay decodes
      // it for click-to-edit.
      if (!requestContext.editor && hasStega(html)) {
        html = stegaClean(html);
        rewritten = true;
      }
      // Authenticated empty-state hint: a signed-in editor landing on a live
      // page with zero data-caret bindings would otherwise get no signal that
      // anything happened (reads as "broken"). Show a small affordance pointing
      // at caretize / the Studio. Editors-only and skipped on CMS-owned pages,
      // so the public never sees it and it never clutters the Studio.
      if (
        services.enableInlineEditor &&
        requestContext.editor &&
        !hasBindings &&
        !isCmsOwnedPath(context, services.mountPath, services.apiBasePath)
      ) {
        html = injectSigninHint(html, services.mountPath);
        rewritten = true;
      }
      body = html;
    }

    if (!bodyConsumed && !setCookieHeader) {
      return inner;
    }

    const headers = new Headers(inner.headers);
    if (rewritten) headers.delete("content-length");
    if (setCookieHeader) headers.append("Set-Cookie", setCookieHeader);

    return new Response(body, { status: inner.status, headers });
  });
}
