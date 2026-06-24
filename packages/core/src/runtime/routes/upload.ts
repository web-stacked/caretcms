export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { UploadError } from "../storage/image-validation.js";
import {
  json,
  getUploadHandler,
  getSessionId,
  enforceCsrfHeader,
  enforceContentLength,
  MAX_UPLOAD_BODY_BYTES,
} from "./_helpers.js";

export async function POST(context: APIContext): Promise<Response> {
  const csrfFailure = enforceCsrfHeader(context.request);
  if (csrfFailure) return csrfFailure;

  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const contentType = context.request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  // Reject oversized uploads before formData() buffers the whole body. Demo
  // sessions get a tighter per-file/per-session cap from QuotaUploadHandler;
  // this is the embedded-mode backstop that would otherwise be unbounded.
  const tooLarge = enforceContentLength(context.request, MAX_UPLOAD_BODY_BYTES);
  if (tooLarge) return tooLarge;

  const formData = await context.request.formData().catch(() => null);
  if (!formData) {
    return json({ error: "Invalid form data" }, 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return json({ error: "Missing file" }, 400);
  }

  try {
    const handler = getUploadHandler();
    const sessionId = getSessionId();
    const result = await handler.upload(
      file,
      sessionId ? { sessionId } : undefined,
    );
    return json({ url: result.url });
  } catch (error) {
    // Only surface curated validation/quota messages. Unexpected errors (e.g.
    // a storage error carrying a filesystem path) are logged and returned
    // opaquely so they never leak to the client.
    if (error instanceof UploadError) {
      return json({ error: error.message }, 400);
    }
    console.error("[caretcms] Upload failed:", error);
    return json({ error: "Upload failed" }, 500);
  }
}
