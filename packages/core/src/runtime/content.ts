/**
 * Public content loading API for Astro pages.
 *
 * Use these in your .astro frontmatter to load CMS content:
 *
 *   import { loadEntry, loadCollection } from '@caretcms/core/runtime'
 *
 *   const home = await loadEntry('pages', 'home')
 *   const posts = await loadCollection('posts')
 */

import type { EntryData } from "../types.js";
import { requireRequestContext } from "./request-context.js";
import { stripBodyOverlay } from "./utils.js";
import { resolveCollectionStudioConfig } from "./schema-registry.js";
import { isPublicEntry } from "./collection-policy.js";

export type { EntryData };

/**
 * Load a single entry by collection and id.
 * Returns the entry data, or null if not found.
 */
export async function loadEntry(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { adapter, editor } = requireRequestContext();
  const entry = await adapter.getEntry(collection, id);
  if (!entry) return null;
  const data = stripBodyOverlay(entry.data);
  const config = await resolveCollectionStudioConfig(adapter, collection);
  return editor || isPublicEntry(data, config) ? data : null;
}

/**
 * Load all entries in a collection.
 * Returns an array of { id, data } objects.
 */
export async function loadCollection(collection: string): Promise<EntryData[]> {
  const { adapter, editor } = requireRequestContext();
  const entries = await adapter.listEntries(collection);
  const config = await resolveCollectionStudioConfig(adapter, collection);
  return entries
    .map((entry) => ({ ...entry, data: stripBodyOverlay(entry.data) }))
    .filter((entry) => editor || isPublicEntry(entry.data, config));
}

/**
 * Discover all collection names.
 * Returns sorted collection names.
 */
export async function listCollections(): Promise<string[]> {
  const { adapter } = requireRequestContext();
  return adapter.discoverCollections();
}
