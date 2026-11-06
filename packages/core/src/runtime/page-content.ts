import type { EntryData, StorageAdapter } from "../types.js";
import { getNestedValue, setNestedValue } from "./utils.js";

/** collection → id → field path ("hero.headline") → the text (or image src) the template renders. */
export type PageContent = Record<string, Record<string, Record<string, string>>>;

/**
 * The content templates state for their `data-caret` bindings, scanned when
 * Astro starts (and again in dev when a template changes). Imported on each
 * use so a dev rescan is picked up without a restart.
 */
export async function loadPageContent(): Promise<PageContent> {
  try {
    const module = await import("virtual:caretcms/page-content");
    return module.default ?? {};
  } catch {
    return {};
  }
}

/** The page's text fills each field path that has no stored value. */
export function merged(entry: EntryData | null, id: string, seed: Record<string, string> | undefined): EntryData | null {
  if (!seed) return entry;
  const data = entry ? structuredClone(entry.data) : {};
  for (const [path, value] of Object.entries(seed)) {
    if (getNestedValue(data, path) !== undefined) continue;
    try {
      setNestedValue(data, path, value);
    } catch {
      // A path the data can't hold (a forbidden key) shows nothing.
    }
  }
  return entry ? { ...entry, data } : { id, data };
}

/**
 * Reads that include what pages show before anything is saved: an entry the
 * templates bind appears with the page's own text, and stored values win
 * field by field. For the Studio and editor reads only; writes, revisions and
 * existence checks stay with the adapter, so nothing here is ever stored.
 */
export function withPageContent(adapter: StorageAdapter, content: PageContent): StorageAdapter {
  if (Object.keys(content).length === 0) return adapter;
  const seedIds = (collection: string) => Object.keys(content[collection] ?? {});
  const reads: Partial<StorageAdapter> = {
    async discoverCollections() {
      const stored = await adapter.discoverCollections();
      return [...stored, ...Object.keys(content).filter((name) => !stored.includes(name))];
    },
    async isKnownCollection(collection: string) {
      return collection in content || adapter.isKnownCollection(collection);
    },
    async getEntry(collection: string, id: string) {
      return merged(await adapter.getEntry(collection, id), id, content[collection]?.[id]);
    },
    async listEntryIds(collection: string) {
      const stored = await adapter.listEntryIds(collection);
      return [...stored, ...seedIds(collection).filter((id) => !stored.includes(id))];
    },
    async listEntries(collection: string) {
      const stored = await adapter.listEntries(collection);
      const ids = new Set(stored.map((entry) => entry.id));
      return [
        ...stored.map((entry) => merged(entry, entry.id, content[collection]?.[entry.id])!),
        ...seedIds(collection).filter((id) => !ids.has(id)).map((id) => merged(null, id, content[collection][id])!),
      ];
    },
  };
  if (adapter.getEntrySnapshot) {
    reads.getEntrySnapshot = async (collection: string, id: string) => {
      const snapshot = await adapter.getEntrySnapshot!(collection, id);
      return { ...snapshot, entry: merged(snapshot.entry, id, content[collection]?.[id]) };
    };
  }
  if (adapter.getEntrySnapshots) {
    reads.getEntrySnapshots = async (collection: string, ids: readonly string[]) =>
      (await adapter.getEntrySnapshots!(collection, ids)).map((snapshot, index) =>
        ({ ...snapshot, entry: merged(snapshot.entry, ids[index], content[collection]?.[ids[index]]) }));
  }
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in reads) return reads[property as keyof StorageAdapter];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Leave out fields that still say exactly what the page says on its own, so
 * saving a whole entry from the Studio doesn't freeze template text that
 * nobody edited. A field set back to the page's text goes back to following it.
 */
export function withoutPageDefaults(
  data: Record<string, unknown>,
  seed: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!seed) return data;
  const kept = structuredClone(data);
  for (const [path, value] of Object.entries(seed)) {
    if (getNestedValue(kept, path) !== value) continue;
    const keys = path.split(".");
    const parent = getNestedValue(kept, keys.slice(0, -1).join("."));
    // Array items keep their place; only object fields are left out.
    if (parent && typeof parent === "object" && !Array.isArray(parent)) delete (parent as Record<string, unknown>)[keys[keys.length - 1]];
  }
  return kept;
}

/**
 * A collection that exists because templates bind it (no schema of its own):
 * its entries are the pages, so there's nothing to create, order or delete.
 */
export function isPageCollection(content: PageContent, collection: string, hasSchema: boolean): boolean {
  return collection in content && !hasSchema;
}
