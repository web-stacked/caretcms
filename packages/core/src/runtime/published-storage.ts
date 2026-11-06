import type { StorageAdapter } from "../types.js";

/**
 * The configured storage for reads outside a request (a static build). The
 * providers module registers it when it loads, so code that only may need it
 * (`editable()`, exported from the package root) never imports the virtual
 * providers module itself: a worker that bundles the root for another export
 * would fail to resolve it. Shared across module copies, like the request
 * context.
 */
const key = Symbol.for("@caretcms/core/published-storage");
const slots = globalThis as typeof globalThis & Record<symbol, unknown>;

export function registerPublishedStorage(get: () => Promise<StorageAdapter>): void {
  slots[key] = get;
}

/** The configured storage, or null without a CaretCMS runtime. */
export async function publishedStorage(): Promise<StorageAdapter | null> {
  const get = slots[key] as (() => Promise<StorageAdapter>) | undefined;
  if (!get) return null;
  try {
    return await get();
  } catch {
    return null;
  }
}
