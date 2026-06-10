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
import {
  getRequestContext,
  requireRequestContext,
} from "./runtime/request-context.js";
import { stegaCombine } from "./runtime/stega.js";

export class CaretLoaderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CaretLoaderError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Draft-mode only: hide each string field's binding key (`collection::id::field`)
 * inside the value itself via stega. The key then rides through component props,
 * slots, and `.map()` loops, so the editor overlay can offer click-to-edit on
 * any rendered string with no `data-caret` attribute. Visitors are never editors,
 * so this is a no-op for them; the rewrite middleware also strips stega from
 * published HTML as a backstop. Nested fields use a dot-path (matching the
 * rewrite engine's `field.path` resolution).
 */
function encodeEntryData(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      return stegaCombine(value, `${collection}::${id}::${path}`);
    }
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, `${path}.${i}`));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, `${path}.${k}`);
      }
      return out;
    }
    return value;
  };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = walk(v, k);
  return out;
}

/** Whether the current request should receive stega-encoded draft content. */
function isEditorRequest(): boolean {
  return getRequestContext()?.editor === true;
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
        const data = isEditorRequest()
          ? encodeEntryData(collection, entry.id, entry.data)
          : entry.data;
        return { id: entry.id, data };
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
        const editor = isEditorRequest();
        return {
          entries: allEntries.map((entry) => ({
            id: entry.id,
            data: editor
              ? encodeEntryData(collection, entry.id, entry.data)
              : entry.data,
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
