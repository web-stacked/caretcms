/**
 * editable() — make an inline value editable in place.
 *
 * The stega twin of `bindEntry` / `data-caret`: instead of putting the binding
 * key on an element (which props/loops break), it hides the key INSIDE the value
 * via stega, so the content stays click-to-edit even when passed through
 * component props, slots, and `.map()` loops — with no attribute and no live
 * collection.
 *
 * Usage in a `.astro` frontmatter:
 *
 *   const features = await editable('pages::home::features.items', [
 *     { title: 'Fast', description: '…' },
 *     { title: 'SEO',  description: '…' },
 *   ]);
 *   <Features items={features} />
 *
 * `key` is `collection::id` or `collection::id::field-prefix`. The value you pass
 * is the DEFAULT — your code stays the source of truth; any saved edits in the
 * store overlay it. In editor mode each string leaf is stega-encoded with its
 * binding key (`collection::id::<dot.path>`), matching the mutation engine's
 * nested-path writes, so edits round-trip to the same store as data-caret.
 *
 * Safe outside a request context (e.g. static build / plain import): returns the
 * value untouched.
 */

import { getRequestContext } from "./runtime/request-context.js";
import { stegaCombine } from "./runtime/stega.js";
import { getNestedValue as getByPath } from "./runtime/utils.js";

/**
 * Overlay `override` onto `base` (override wins where defined). Objects merge by
 * key, arrays merge by index — so a single saved item field overlays only that
 * leaf and untouched defaults survive. Scalars: override replaces base.
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (Array.isArray(base) && Array.isArray(override)) {
    return base.map((item, i) => deepMerge(item, override[i]));
  }
  if (
    base !== null &&
    typeof base === "object" &&
    !Array.isArray(base) &&
    override !== null &&
    typeof override === "object" &&
    !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    return out;
  }
  return override;
}

/**
 * An imported asset (Astro `ImageMetadata`): `{ src, width, height, format }`.
 * Its strings are machine identifiers (URL, format token) consumed by the image
 * pipeline — NOT human-readable text. Stega-encoding them corrupts the value
 * (e.g. `format: "jpg"` → `"jpg<invisible>"`, which `astro:assets` rejects), so
 * these objects must pass through `encodeLeaves` untouched.
 */
function isAssetLike(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.src === "string" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.format === "string"
  );
}

/** Stega-encode every string leaf with its full `collection::id::field` key. */
function encodeLeaves(
  value: unknown,
  collection: string,
  id: string,
  fieldPath: string,
): unknown {
  if (typeof value === "string") {
    return stegaCombine(value, `${collection}::${id}::${fieldPath}`);
  }
  // Asset descriptors (ImageMetadata) carry identifiers, not editable text —
  // leave them intact so the image pipeline receives a clean src/format.
  if (isAssetLike(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      encodeLeaves(v, collection, id, fieldPath ? `${fieldPath}.${i}` : `${i}`),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeLeaves(v, collection, id, fieldPath ? `${fieldPath}.${k}` : k);
    }
    return out;
  }
  return value;
}

export async function editable<T>(key: string, value: T): Promise<T> {
  const ctx = getRequestContext();
  if (!ctx) return value;

  const parts = key.split("::");
  const collection = parts[0];
  const id = parts[1];
  const fieldPrefix = parts.slice(2).join("::");
  if (!collection || !id) return value;

  // 1. Overlay: merge any saved values over the inline default.
  let result: unknown = value;
  try {
    const stored = await ctx.adapter.getEntry(collection, id);
    if (stored && stored.data) {
      const override = fieldPrefix ? getByPath(stored.data, fieldPrefix) : stored.data;
      result = deepMerge(value, override);
    }
  } catch {
    // store unavailable → keep the inline default
  }

  // 2. Stega: editor only — embed binding keys so it's click-to-edit through
  //    whatever props/loops the value flows through.
  if (ctx.editor) {
    result = encodeLeaves(result, collection, id, fieldPrefix);
  }

  return result as T;
}
