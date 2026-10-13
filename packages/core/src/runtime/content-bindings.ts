/**
 * Automatic bindings for content a theme reads as data.
 *
 * Most themes keep their copy in content collections or JSON files and pass it
 * through helpers, loops, and component props, so no element in the source
 * says where a string is stored. During an editor's request the values carry
 * that address themselves: each display string is stega-encoded with its
 * `collection::id::field` key (as `editable()` does by hand), and the
 * editor's drafts are overlaid so a reload shows them.
 *
 * - `bindCollectionEntries` / `bindCollectionEntry` wrap `astro:content`
 *   reads. The integration routes theme imports of `astro:content` through a
 *   module that applies them.
 * - `bindDataFile` wraps a JSON file imported from the content root.
 *
 * Only entries the storage adapter can resolve are bound, so a key always
 * points at something an edit can be saved to. Visitors get values untouched.
 */

import { getRequestContext } from "./request-context.js";
import { getRegisteredSchema } from "./schema-registry.js";
import { encodeBound, encodeContent, isEncodableText, mergeStored } from "./stega-policy.js";
import { dataFileBinding, dataFileShape } from "./storage/data-file-codec.js";
import { getNestedValue } from "./utils.js";
import type { StorageAdapter } from "../types.js";

type ContentEntry = { id: string; collection: string; data: Record<string, unknown> };

function isContentEntry(value: unknown): value is ContentEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<ContentEntry>;
  return typeof entry.id === "string" && typeof entry.collection === "string"
    && typeof entry.data === "object" && entry.data !== null;
}

async function bindEntry<T>(entry: T): Promise<T> {
  const ctx = getRequestContext();
  if (!ctx?.editor || !isContentEntry(entry)) return entry;
  let stored: Record<string, unknown> | null = null;
  try {
    stored = (await ctx.adapter.getEntry(entry.collection, entry.id))?.data ?? null;
  } catch {
    return entry;
  }
  if (!stored) return entry;
  const data = mergeStored(entry.data, stored);
  const schema = getRegisteredSchema(entry.collection)?.schema;
  return { ...entry, data: encodeContent(data, `${entry.collection}::${entry.id}`, "", schema) } as T;
}

export async function bindCollectionEntry<T>(entry: T): Promise<T> {
  return entry ? bindEntry(entry) : entry;
}

export async function bindCollectionEntries<T>(entries: T): Promise<T> {
  if (!Array.isArray(entries) || !getRequestContext()?.editor) return entries;
  return (await Promise.all(entries.map((entry) => bindEntry(entry)))) as T;
}

/**
 * Read every data-file collection's stored entries for an editor request.
 * Imported data files are read synchronously during render, so their drafts
 * must be loaded before it starts.
 */
export async function loadDataFileEntries(adapter: StorageAdapter): Promise<Map<string, Map<string, Record<string, unknown>>>> {
  const out = new Map<string, Map<string, Record<string, unknown>>>();
  if (!adapter.isDocumentCollection) return out;
  for (const collection of await adapter.discoverCollections()) {
    if (await adapter.isDocumentCollection(collection)) continue;
    const entries = new Map<string, Record<string, unknown>>();
    for (const entry of await adapter.listEntries(collection)) entries.set(entry.id, entry.data);
    out.set(collection, entries);
  }
  return out;
}

const proxies = new WeakMap<object, unknown>();

/**
 * Wrap a data file imported from the content root (`import site from
 * "../content/site.json"`). Theme modules usually keep the import in a
 * module-level constant, so the value is created once; the proxy reads the
 * request on each property access instead. For visitors it returns the
 * original values.
 */
export function bindDataFile<T>(value: T, collection: string): T {
  const shape = dataFileShape(value);
  if (!shape || typeof value !== "object" || value === null) return value;
  const root = value;

  const wrap = (target: object, path: readonly string[]): unknown => {
    const cached = proxies.get(target);
    if (cached) return cached;
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        const raw = Reflect.get(object, key, receiver);
        if (typeof key === "symbol" || (Array.isArray(object) && key === "length")) return raw;
        const ctx = getRequestContext();
        if (!ctx?.editor) return raw;
        const childPath = [...path, key];
        if (typeof raw === "object" && raw !== null) return wrap(raw, childPath);
        const binding = dataFileBinding(shape, collection, root, childPath);
        if (!binding) return raw;
        const stored = ctx.dataFiles?.get(collection)?.get(binding.id);
        if (!stored) return raw;
        const current = mergeStored(raw, getNestedValue(stored, binding.field));
        if (typeof current !== "string") return current;
        return isEncodableText(current, key)
          ? encodeBound(current, `${collection}::${binding.id}::${binding.field}`)
          : current;
      },
    });
    proxies.set(target, proxy);
    return proxy;
  };

  return wrap(root, []) as T;
}
