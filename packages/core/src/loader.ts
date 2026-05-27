/**
 * Astro LiveLoader backed by the configured StorageAdapter.
 *
 * Compatible with Astro 6 (stable live content collections) and Astro 5.10+
 * (where the feature lives behind `experimental.liveContentCollections`).
 *
 * Usage in src/caret.config.ts:
 *
 *   import { defineLiveCollection } from 'astro:content';
 *   import { caretLoader } from '@caretcms/core';
 *
 *   const pages = defineLiveCollection({
 *     loader: caretLoader('pages'),
 *   });
 *   export const collections = { pages };
 */

import type { StorageAdapter, EntryData } from "./types.js";
import { requireRequestContext } from "./runtime/request-context.js";

export class CaretLoaderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CaretLoaderError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function requireAdapter(): StorageAdapter {
  try {
    return requireRequestContext().adapter;
  } catch (cause) {
    throw new CaretLoaderError(
      "StorageAdapter not initialized. " +
        "Ensure @caretcms/core middleware runs before page rendering " +
        "(the integration registers it with order: 'pre').",
      cause,
    );
  }
}

// ---------------------------------------------------------------------------
// LiveLoader factory
// ---------------------------------------------------------------------------

type CaretEntryFilter = { id: string };

type CaretLiveDataEntry = {
  id: string;
  data: Record<string, unknown>;
};

type CaretLiveDataCollection = {
  entries: CaretLiveDataEntry[];
};

type CaretLoadEntryContext = {
  filter: CaretEntryFilter;
  collection: string;
};

type CaretLoadCollectionContext = {
  filter?: Record<string, unknown>;
  collection: string;
};

/**
 * Structural LiveLoader type that is compatible with Astro's LiveLoader
 * interface (stable in 6.x, experimental in 5.10+) without importing it
 * directly — avoids hard peer-dep coupling at the type level and lets a
 * single build target both major versions.
 */
export type CaretLiveLoader = {
  name: string;
  loadEntry: (
    context: CaretLoadEntryContext,
  ) => Promise<CaretLiveDataEntry | undefined | { error: CaretLoaderError }>;
  loadCollection: (
    context: CaretLoadCollectionContext,
  ) => Promise<CaretLiveDataCollection | { error: CaretLoaderError }>;
};

/**
 * Create an Astro LiveLoader that reads from the configured StorageAdapter.
 * Works on Astro 6 (stable) and Astro 5.10+ (experimental flag required).
 *
 * @param collection - The collection name (must be known to the adapter).
 */
export function caretLoader(
  collection: string,
): CaretLiveLoader {
  return {
    name: `caret:${collection}`,

    async loadEntry({ filter }) {
      try {
        const adapter = requireAdapter();
        const id = filter.id;
        const entry = await adapter.getEntry(collection, id);
        if (!entry) return undefined;
        return { id: entry.id, data: entry.data };
      } catch (error) {
        return {
          error: new CaretLoaderError(
            `Failed to load entry ${collection}::${filter.id}`,
            error,
          ),
        };
      }
    },

    async loadCollection() {
      try {
        const adapter = requireAdapter();
        const allEntries: EntryData[] = await adapter.listEntries(collection);
        return {
          entries: allEntries.map((entry) => ({
            id: entry.id,
            data: entry.data,
          })),
        };
      } catch (error) {
        return {
          error: new CaretLoaderError(
            `Failed to load collection ${collection}`,
            error,
          ),
        };
      }
    },
  };
}
