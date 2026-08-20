export const prerender = false;

import type { APIContext } from "astro";
import { isEditorAuthenticated } from "../auth/session.js";
import { parseCollectionName, parseEntryId } from "../mutations/contracts.js";
import { stripBodyOverlay } from "../utils.js";
import { getRegisteredSchema } from "../schema-registry.js";
import { validateJsonSchema, type JsonSchemaValidationIssue } from "../../schema-utils.js";
import { json, resolveAdapter } from "./_helpers.js";

type CmsEntryResponse = {
  id: string;
  data: Record<string, unknown>;
  revision: number;
  validationIssues?: JsonSchemaValidationIssue[];
};

function withValidation(
  collection: string,
  entry: { id: string; data: Record<string, unknown> },
  revision: number,
): CmsEntryResponse {
  const data = stripBodyOverlay(entry.data);
  const schema = getRegisteredSchema(collection)?.schema;
  const validationIssues = schema ? validateJsonSchema(data, schema) : [];
  return {
    id: entry.id,
    data,
    revision,
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

  const adapter = await resolveAdapter();
  const { collection, id: singleId, page, pageSize, q } = query;

  if (singleId) {
    const entry = await adapter.getEntry(collection, singleId);
    const revision = entry ? await adapter.getRevision(collection, singleId) : 0;
    const entries: CmsEntryResponse[] = entry
      ? [withValidation(collection, entry, revision)]
      : [];

    return json({
      entries,
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
  const filteredIds = q ? allIds.filter((entryId) => entryId.toLowerCase().includes(q)) : allIds;

  const total = filteredIds.length;
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  const effectivePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
  const start = (effectivePage - 1) * pageSize;
  const pageIds = filteredIds.slice(start, start + pageSize);

  const rawEntries = await Promise.all(pageIds.map((entryId) => adapter.getEntry(collection, entryId)));
  const entries: CmsEntryResponse[] = await Promise.all(
    rawEntries
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map(async (entry) => withValidation(
        collection,
        entry,
        await adapter.getRevision(collection, entry.id),
      )),
  );

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
}
