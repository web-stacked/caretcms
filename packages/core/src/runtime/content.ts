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

export type { EntryData };

/**
 * Load a single entry by collection and id.
 * Returns the entry data, or null if not found.
 */
export async function loadEntry(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { adapter } = requireRequestContext();
  const entry = await adapter.getEntry(collection, id);
  return entry?.data ?? null;
}

/**
 * Load all entries in a collection.
 * Returns an array of { id, data } objects.
 */
export async function loadCollection(collection: string): Promise<EntryData[]> {
  const { adapter } = requireRequestContext();
  return adapter.listEntries(collection);
}

/**
 * Discover all collection names.
 * Returns sorted collection names.
 */
export async function listCollections(): Promise<string[]> {
  const { adapter } = requireRequestContext();
  return adapter.discoverCollections();
}
