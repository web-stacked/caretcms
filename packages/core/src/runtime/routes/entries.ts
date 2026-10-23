export const prerender = false;

import type { APIContext } from "astro";
import { matchEntry } from "../entry-search.js";
import { isEditorAuthenticated } from "../auth/session.js";
import { parseCollectionName, parseEntryId } from "../mutations/contracts.js";
import { stripBodyOverlay } from "../utils.js";
import { getRegisteredSchema } from "../schema-registry.js";
import { validateJsonSchema, type JsonSchemaValidationIssue } from "../../schema-utils.js";
import { contentReadFailure } from "../content-errors.js";
import { json, resolveAdapter } from "./_helpers.js";
import { getRequestContext } from "../request-context.js";
import { readEntrySnapshot, readEntrySnapshots } from "../storage/read-snapshot.js";

type CmsEntryResponse = {
  id: string;
  data: Record<string, unknown>;
  revision: number;
  baseRevision?: number;
  validationIssues?: JsonSchemaValidationIssue[];
  readError?: { code: string; error: string };
  /** For a search hit inside a field rather than the title: where, and the words around it. */
  match?: { field: string; snippet: string };
};

function withValidation(
  collection: string,
  entry: { id: string; data: Record<string, unknown> },
  revision: number,
  baseRevision?: number,
): CmsEntryResponse {
  const data = stripBodyOverlay(entry.data);
  const schema = getRegisteredSchema(collection)?.schema;
  const validationIssues = schema ? validateJsonSchema(data, schema) : [];
  return {
    id: entry.id,
    data,
    revision,
    ...(baseRevision !== undefined ? { baseRevision } : {}),
    ...(validationIssues.length > 0 ? { validationIssues } : {}),
  };
}

type PaginationResponse = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  q?: string;
};

type QueryInput = {
  collection: string;
  id?: string;
  page: number;
  pageSize: number;
  q?: string;
};

function asPositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function parseQuery(context: APIContext): Promise<QueryInput | null> {
  const url = new URL(context.request.url);
  // Validate the collection name's format only — a well-formed but not-yet-
  // created collection is legitimate (the editor reads an entry's revision
  // before its very first write, which auto-creates the collection). Gating on
  // existence here would 400 that read and silently abort the first save.
  const rawCollection = parseCollectionName(url.searchParams.get("collection"));
  if (!rawCollection) return null;

  const rawIdValue = url.searchParams.get("id");
  const id = rawIdValue && rawIdValue.trim().length > 0 ? parseEntryId(rawIdValue) : undefined;
  if (rawIdValue && rawIdValue.trim().length > 0 && !id) return null;

  const page = asPositiveInt(url.searchParams.get("page"), 1);
  const pageSize = Math.min(asPositiveInt(url.searchParams.get("pageSize"), 24), 100);
  const qRaw = (url.searchParams.get("q") ?? "").trim();

  return {
    collection: rawCollection,
    id: id ?? undefined,
    page,
    pageSize,
    q: qRaw.length > 0 ? qRaw.toLowerCase() : undefined,
  };
}

export async function GET(context: APIContext): Promise<Response> {
  if (!isEditorAuthenticated(context)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const query = await parseQuery(context);
  if (!query) {
    return json(
      {
        error:
          "Invalid query. Provide a valid collection name matching a known collection.",
      },
      400,
    );
  }

  try {
    const adapter = await resolveAdapter();
    const { collection, id: singleId, page, pageSize, q } = query;

    if (singleId) {
      const { entry, revision, baseRevision } = await readEntrySnapshot(adapter, collection, singleId);
      const entries: CmsEntryResponse[] = entry
        ? [withValidation(collection, entry, revision, baseRevision)]
        : [];
      // With a private draft overlay, also return what visitors see, so the
      // Studio can say whether this entry has unpublished changes and what
      // publishing would change.
      const base = getRequestContext()?.publishedAdapter;
      const published = base ? await readEntrySnapshot(base, collection, singleId) : null;

      return json({
        entries,
        revision,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        ...(published ? { live: { data: published.entry ? stripBodyOverlay(published.entry.data) : null } } : {}),
        pagination: {
          page: 1,
          pageSize: 1,
          total: entries.length,
          totalPages: entries.length > 0 ? 1 : 0,
          hasPrev: false,
          hasNext: false,
        } satisfies PaginationResponse,
      });
    }

    const allIds = await adapter.listEntryIds(collection);
    const cache = new Map<string, CmsEntryResponse | null>();
    async function readEntry(id: string): Promise<CmsEntryResponse | null> {
      if (cache.has(id)) return cache.get(id)!;
      let result: CmsEntryResponse | null;
      try {
        const { entry, revision, baseRevision } = await readEntrySnapshot(adapter, collection, id);
        result = entry ? withValidation(collection, entry, revision, baseRevision) : null;
      } catch (error) {
        result = { id, data: {}, revision: 0, readError: contentReadFailure(error) };
      }
      cache.set(id, result);
      return result;
    }
    async function readBatch(ids: string[]): Promise<Array<CmsEntryResponse | null>> {
      if (adapter.getEntrySnapshots && ids.some(id => !cache.has(id))) {
        const missing = ids.filter(id => !cache.has(id));
        try {
          const snapshots = await readEntrySnapshots(adapter, collection, missing);
          snapshots.forEach(({ entry, revision, baseRevision }, index) => {
            cache.set(missing[index], entry ? withValidation(collection, entry, revision, baseRevision) : null);
          });
        } catch {
          // Isolate a corrupt entry or unsupported batch implementation using
          // existing per-entry errors instead of failing the whole collection.
          return Promise.all(ids.map(readEntry));
        }
      }
      return Promise.all(ids.map(readEntry));
    }
    const filteredIds: string[] = [];
    const fieldMatches = new Map<string, { field: string; snippet: string }>();
    // Bounded batches avoid unbounded simultaneous reads on remote adapters.
    if (q) {
      const titleHits: string[] = [];
      const fieldHits: string[] = [];
      for (let offset = 0; offset < allIds.length; offset += 20) {
        const batch = await readBatch(allIds.slice(offset, offset + 20));
        for (const entry of batch) {
          if (!entry) continue;
          const match = matchEntry(entry.id, entry.data, q);
          if (match?.kind === "title") titleHits.push(entry.id);
          else if (match) {
            fieldHits.push(entry.id);
            fieldMatches.set(entry.id, { field: match.field, snippet: match.snippet });
          }
        }
      }
      // Entries named by the query come before ones that only mention it.
      filteredIds.push(...titleHits, ...fieldHits);
    } else filteredIds.push(...allIds);
    const total = filteredIds.length;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
    const effectivePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const start = (effectivePage - 1) * pageSize;
    const pageIds = filteredIds.slice(start, start + pageSize);
    const entries = (await readBatch(pageIds))
      .filter((entry): entry is CmsEntryResponse => entry !== null)
      .map((entry) => {
        const match = fieldMatches.get(entry.id);
        return match ? { ...entry, match } : entry;
      });

    return json({
      entries,
      pagination: {
        page: effectivePage,
        pageSize,
        total,
        totalPages,
        hasPrev: effectivePage > 1,
        hasNext: effectivePage < totalPages,
        q,
      } satisfies PaginationResponse,
      collection,
      source: "adapter",
    });
  } catch (error) {
    const failure = contentReadFailure(error);
    return json(failure, failure.code === "storage_error" ? 503 : 422);
  }
}
