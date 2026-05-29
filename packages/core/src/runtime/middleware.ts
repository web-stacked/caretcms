import type { StorageAdapter, UploadHandler } from "../types.js";
import { isEditorAuthenticated } from "./auth/session.js";
import { isDemoModeEnabled, resolveDemoSession } from "./auth/demo-session.js";
import { getRuntimeServices } from "./providers.js";
import { runWithRequestContext } from "./request-context.js";
import { rewriteCaretAttributes } from "./rewrite.js";
import { SessionOverlayAdapter } from "./storage/session-overlay-adapter.js";

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

export async function onRequest(
  context: MiddlewareContext,
  next: MiddlewareNext,
): Promise<Response> {
  const services = await getRuntimeServices();
  const runtimeEnv = await resolveRuntimeEnv();

  let adapter: StorageAdapter = services.adapter;
  let uploadHandler: UploadHandler = services.uploadHandler;
  let sessionId: string | null = null;
  let setCookieHeader: string | null = null;
  let overlayActive = false;
  const demoMode = isDemoModeEnabled(runtimeEnv);

  if (demoMode) {
    const request = context.request ?? new Request("http://localhost/");
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
  }

  return runWithRequestContext(
    { adapter, uploadHandler, sessionId, demoMode, overlayActive },
    async () => {
    context.locals.isEditor = isEditorAuthenticated(
      context as Parameters<typeof isEditorAuthenticated>[0],
    );
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
      const html = await inner.text();
      bodyConsumed = true;
      if (html.includes("data-caret")) {
        body = await rewriteCaretAttributes(html, adapter);
        rewritten = true;
      } else {
        body = html;
      }
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
