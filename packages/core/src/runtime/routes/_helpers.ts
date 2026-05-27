import type { StorageAdapter, UploadHandler } from "../../types.js";
import { requireRequestContext } from "../request-context.js";

const CSRF_HEADER = "x-caret-request";
const CSRF_HEADER_VALUE = "1";

export function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
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
