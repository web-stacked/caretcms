import { getRequestContext } from "./request-context.js";
import { SessionOverlayAdapter } from "./storage/session-overlay-adapter.js";
import { stripBodyOverlay } from "./utils.js";

export type UnpublishedEntry = { collection: string; id: string; deleted: boolean };

/** JSON with object keys sorted, so equal content compares equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The current request's editor drafts, when it works on drafts (not a demo sandbox). */
function draftScope() {
  const context = getRequestContext();
  if (!context?.overlayActive || context.demoMode || !context.publishedAdapter) return null;
  if (!(context.adapter instanceof SessionOverlayAdapter)) return null;
  return { drafts: context.adapter, published: context.publishedAdapter };
}

/**
 * Entries in one collection whose draft differs from what visitors see: edited,
 * new, deleted, or with body-block drafts. A draft edited back to the
 * published content is not listed.
 */
export async function unpublishedEntries(collection: string): Promise<UnpublishedEntry[]> {
  const scope = draftScope();
  if (!scope) return [];
  const out: UnpublishedEntry[] = [];
  for (const id of await scope.drafts.draftIds(collection)) {
    const [draft, published] = await Promise.all([
      scope.drafts.getEntry(collection, id),
      scope.published.getEntry(collection, id),
    ]);
    if (!draft) {
      if (published) out.push({ collection, id, deleted: true });
      continue;
    }
    const body = draft.data.__body;
    const hasBodyDrafts = Boolean(body && typeof body === "object" && Object.keys(body).length > 0);
    if (!published || hasBodyDrafts || stableJson(stripBodyOverlay(draft.data)) !== stableJson(stripBodyOverlay(published.data))) {
      out.push({ collection, id, deleted: false });
    }
  }
  return out;
}

/** Every entry the current editor has not published yet, across collections. */
export async function allUnpublishedEntries(): Promise<UnpublishedEntry[]> {
  const scope = draftScope();
  if (!scope) return [];
  const collections = await scope.drafts.draftCollections();
  return (await Promise.all(collections.map(unpublishedEntries))).flat();
}

/** Whether the current request works on drafts that need publishing. */
export function worksOnDrafts(): boolean {
  return draftScope() !== null;
}
