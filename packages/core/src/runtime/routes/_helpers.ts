import type { StorageAdapter, UploadHandler } from "../../types.js";
import {
  getRequestContext,
  requireRequestContext,
  type CaretRequestContext,
} from "../request-context.js";
import { getRuntimeServices } from "../providers.js";

let bootstrapContext: Promise<CaretRequestContext> | null = null;

async function bootstrapRequestContext(): Promise<CaretRequestContext> {
  if (!bootstrapContext) {
    bootstrapContext = getRuntimeServices().then((services) => ({
      adapter: services.adapter,
      uploadHandler: services.uploadHandler,
      sessionId: null,
      editorId: null,
      demoMode: false,
      overlayActive: false,
      editor: false,
    }));
  }
  return bootstrapContext;
}

/**
 * Storage adapter for CMS API/Studio routes. Prefer the middleware ALS scope;
 * fall back to the configured base adapter when injectRoute handlers run
 * outside middleware (seen in Astro static dev after HMR or stale processes).
 */
export async function resolveAdapter(): Promise<StorageAdapter> {
  const ctx = getRequestContext();
  if (ctx) return ctx.adapter;
  return (await bootstrapRequestContext()).adapter;
}

export async function resolveUploadHandler(): Promise<UploadHandler> {
  const ctx = getRequestContext();
  if (ctx) return ctx.uploadHandler;
  return (await bootstrapRequestContext()).uploadHandler;
}

const CSRF_HEADER = "x-caret-request";
const CSRF_HEADER_VALUE = "1";

export function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Default cap for JSON command payloads (mutate/history/login). */
export const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MB
/** Default cap for multipart upload bodies before they're buffered. */
export const MAX_UPLOAD_BODY_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Reject a request whose declared Content-Length exceeds `maxBytes`. Cheap
 * first line of defense for bodies we must hand to a buffering parser (e.g.
 * formData()): an honest client and most attacks announce their size. Returns
 * a 413 response when over the cap, otherwise null. Absent/garbage
 * Content-Length passes here — pair with a streaming cap where possible.
 */
export function enforceContentLength(
  request: Request,
  maxBytes: number,
): Response | null {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return json({ error: "Payload too large" }, 413);
  }
  return null;
}

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

/**
 * Read and JSON-parse a request body with a hard byte cap, streaming the body
 * and aborting once the running total exceeds `maxBytes` so an attacker can't
 * exhaust memory by omitting Content-Length and sending a chunked flood.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<JsonBodyResult> {
  const tooLarge = enforceContentLength(request, maxBytes);
  if (tooLarge) return { ok: false, response: tooLarge };

  let text: string;
  try {
    text = await readBodyTextCapped(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return { ok: false, response: json({ error: "Payload too large" }, 413) };
    }
    return { ok: false, response: json({ error: "Invalid body" }, 400) };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "Invalid JSON" }, 400) };
  }
}

class BodyTooLargeError extends Error {}

async function readBodyTextCapped(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const body = request.body;
  if (!body) {
    const text = await request.text();
    if (text.length > maxBytes) throw new BodyTooLargeError();
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Lightweight CSRF defense for mutating endpoints.
 *
 * Cookies use SameSite=Lax, so a cross-origin top-level POST won't carry the
 * session — but a same-origin XSS or any future cross-origin fetch with
 * credentials would. Requiring a custom request header forces a CORS preflight
 * for any cross-origin caller and blocks form-based submissions outright.
 *
 * Returns a 403 response if the header is missing, otherwise null.
 */
export function enforceCsrfHeader(request: Request): Response | null {
  if (request.headers.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return json(
      {
        error: "Missing required request header",
        detail: `Send '${CSRF_HEADER}: ${CSRF_HEADER_VALUE}' on mutating CMS requests.`,
      },
      403,
    );
  }
  return null;
}

export function getAdapter(): StorageAdapter {
  return requireRequestContext().adapter;
}

export function getUploadHandler(): UploadHandler {
  return requireRequestContext().uploadHandler;
}

export function getSessionId(): string | null {
  return requireRequestContext().sessionId;
}
