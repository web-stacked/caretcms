import type { StorageAdapter, UploadHandler } from "../../types.js";
import type { DraftConflict } from "../storage/session-overlay-adapter.js";
import type { EntryFieldChanges, UnpublishedEntry } from "../unpublished.js";
import { loadPageContent, withPageContent } from "../page-content.js";
import {
  getRequestContext,
  requireRequestContext,
  type CaretRequestContext,
} from "../request-context.js";
import { getRuntimeServices } from "../providers.js";
import { entryDisplayTitle, humanizeEntryId } from "../entry-title.js";
import { getRegisteredSchema, resolveCollectionStudioConfig } from "../schema-registry.js";

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

/**
 * The adapter for Studio and editor reads: it also lists what pages show
 * before anything is saved (page-content.ts). Never for writes.
 */
export async function resolveReadAdapter(): Promise<StorageAdapter> {
  return withPageContent(await resolveAdapter(), await loadPageContent());
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
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
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
    text = new TextDecoder().decode(await readBodyBytesCapped(request, maxBytes));
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

/** Bound multipart and URL-encoded bodies before handing them to formData(). */
export async function readFormBody(request: Request, maxBytes: number): Promise<
  { ok: true; value: FormData } | { ok: false; response: Response }
> {
  const tooLarge = enforceContentLength(request, maxBytes);
  if (tooLarge) return { ok: false, response: tooLarge };
  try {
    const bytes = await readBodyBytesCapped(request, maxBytes);
    const value = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, response: json({ error: error instanceof BodyTooLargeError ? "Payload too large" : "Invalid form data" }, error instanceof BodyTooLargeError ? 413 : 400) };
  }
}

class BodyTooLargeError extends Error {}

async function readBodyBytesCapped(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = request.body;
  if (!body) {
    return new Uint8Array();
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
  return merged;
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

/** Name entries the editor must act on (conflicts, failures) as the Studio does. */
export async function withTitles<T extends { collection: string; id: string }>(
  base: StorageAdapter,
  overlay: StorageAdapter,
  entries: T[],
): Promise<Array<T & { title: string }>> {
  return Promise.all(entries.map(async (entry) => {
    const [config, stored] = await Promise.all([
      resolveCollectionStudioConfig(base, entry.collection),
      overlay.getEntry(entry.collection, entry.id).catch(() => null)
        .then((draft) => draft ?? base.getEntry(entry.collection, entry.id).catch(() => null)),
    ]);
    return { ...entry, title: entryDisplayTitle(entry.collection, entry.id, stored?.data, config) };
  }));
}

/** A value as short text for a message: strings as they are (markup removed), anything else as JSON. */
function preview(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Draft conflicts as the editor reads them: entry title, field labels and both values as text. */
export async function describeDraftConflicts(base: StorageAdapter, overlay: StorageAdapter, conflicts: DraftConflict[]) {
  return (await withTitles(base, overlay, conflicts)).map((conflict) => {
    const properties = (getRegisteredSchema(conflict.collection) as { properties?: Record<string, { title?: unknown }> } | undefined)?.properties ?? {};
    return { collection: conflict.collection, id: conflict.id, title: conflict.title, removed: conflict.removed, body: conflict.body,
      fields: conflict.fields.map(({ field, mine, site }) => ({ field,
        label: typeof properties[field]?.title === "string" ? properties[field].title as string : humanizeEntryId(field),
        mine: preview(mine), site: preview(site) })) };
  });
}

/** Draft changes as the editor reads them: entry title, field labels and each value as short text. */
export async function describeDraftChanges(base: StorageAdapter, overlay: StorageAdapter, entries: EntryFieldChanges[]) {
  return (await withTitles(base, overlay, entries)).map((entry) => {
    const properties = (getRegisteredSchema(entry.collection) as { properties?: Record<string, { title?: unknown }> } | undefined)?.properties ?? {};
    return { collection: entry.collection, id: entry.id, title: entry.title,
      changes: entry.changes.map(({ field, kind, started, mine, site }) => ({ field, kind,
        label: typeof properties[field]?.title === "string" ? properties[field].title as string : humanizeEntryId(field),
        started: preview(started), mine: preview(mine), site: preview(site) })) };
  });
}

/**
 * What Publish would publish, as the editor reads it: each pending draft by
 * title, with the fields the editor changed (the site's value and theirs) and
 * whether it also holds edited body text.
 */
export async function describePendingDrafts(
  base: StorageAdapter, overlay: StorageAdapter, pending: UnpublishedEntry[], changes: Awaited<ReturnType<typeof describeDraftChanges>>,
) {
  return Promise.all((await withTitles(base, overlay, pending)).map(async (entry) => {
    const body = (await overlay.getEntry(entry.collection, entry.id).catch(() => null))?.data.__body;
    return { collection: entry.collection, id: entry.id, title: entry.title, deleted: entry.deleted,
      text: Boolean(body && typeof body === "object" && Object.keys(body).length > 0),
      fields: (changes.find(candidate => candidate.collection === entry.collection && candidate.id === entry.id)?.changes ?? [])
        .filter(change => change.kind !== "site").map(({ label, site, mine }) => ({ label, site, mine })) };
  }));
}
