/**
 * Which content strings may carry a hidden binding key.
 *
 * Content bound automatically (Astro `getCollection()` results, imported data
 * files) flows through theme code that compares, looks up, and routes on some
 * of its strings: `category === "espresso"`, `<Icon name={item.icon}>`,
 * `href === Astro.url.pathname`. A key appended to such a value breaks that
 * code, so only display text is encoded. The schema decides first (enums,
 * consts, and formats are machine values); without one, field names and the
 * value's shape decide.
 */

import type { JsonSchemaNode } from "../schema-utils.js";
import { hasStega, stegaCombine } from "./stega.js";

/** Field names whose values are identifiers, not prose. */
const MACHINE_FIELD = /^(id|uid|uuid|slug|key|lang|locale|type|kind|variant|layout|template|icon|class|classname|color|colour|theme|target|rel|format|currency|status|mode|code|tag|tags|hash|anchor|component)$/i;

const MACHINE_FORMAT = new Set(["date", "date-time", "time", "email", "uri", "uri-reference", "uuid", "hostname", "ipv4", "ipv6", "regex"]);

const IMAGE_PATH = /\.(png|jpe?g|webp|avif|gif|svg)(\?[^\s]*)?$/i;
const LINK_OR_PATH = /^(https?:|mailto:|tel:|data:|\/|#|\.\.?\/)/i;
const TOKEN = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const NUMERIC = /^[\d\s.,:+\-/%]+$/;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

function schemaForbids(schema: JsonSchemaNode | undefined): boolean {
  if (!schema) return false;
  if (Array.isArray(schema.enum) || "const" in schema) return true;
  return typeof schema.format === "string" && MACHINE_FORMAT.has(schema.format);
}

/**
 * FNV-1a over the whitespace-collapsed text. The browser binds an element only
 * when its visible text hashes the same, so a value the theme split into
 * words, truncated, or rewrote in code is never bound: saving it would replace
 * the whole stored value with a fragment. Mirrored in editor/stega-hydrate.js.
 */
export function contentHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** A value with its binding key and content hash hidden at the end. */
export function encodeBound(value: string, key: string): string {
  return stegaCombine(value, { k: key, h: contentHash(value) });
}

/** The binding key of a decoded payload: a bare key (`editable()`, live
 *  loaders) or `{ k, h }`, accepted only when `text` still hashes to `h`. */
export function payloadKey(payload: unknown, text: string): string | undefined {
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const { k, h } = payload as { k?: unknown; h?: unknown };
  return typeof k === "string" && h === contentHash(text) ? k : undefined;
}

/** True when `value` at `fieldName` is display text that may carry a key. */
export function isEncodableText(value: string, fieldName: string, schema?: JsonSchemaNode): boolean {
  const text = value.trim();
  if (!text || hasStega(value)) return false;
  if (schemaForbids(schema)) return false;
  if (MACHINE_FIELD.test(fieldName)) return false;
  // Image paths stay encodable: the middleware strips the key from the
  // attribute and binds the <img>, which makes the image replaceable.
  if (LINK_OR_PATH.test(text)) return IMAGE_PATH.test(text);
  if (TOKEN.test(text) || NUMERIC.test(text) || HEX_COLOR.test(text)) return false;
  return true;
}

function childSchema(schema: JsonSchemaNode | undefined, key: string | number): JsonSchemaNode | undefined {
  if (!schema) return undefined;
  if (typeof key === "number") return schema.items;
  return schema.properties?.[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Encode every display string in `value` with `prefix::<dot.path>`. Objects
 * that are not plain records (Dates, image metadata, class instances) pass
 * through untouched, as do keys starting with `__` (private storage keys).
 */
export function encodeContent(value: unknown, prefix: string, path: string, schema?: JsonSchemaNode, fieldName = ""): unknown {
  if (typeof value === "string") {
    return isEncodableText(value, fieldName, schema) ? encodeBound(value, `${prefix}::${path}`) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => encodeContent(item, prefix, path ? `${path}.${index}` : `${index}`, childSchema(schema, index), fieldName));
  }
  if (isRecord(value)) {
    // Image metadata (`{ src, width, height, format }`) feeds the image pipeline.
    if (typeof value.src === "string" && typeof value.width === "number" && typeof value.format === "string") return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = key.startsWith("__")
        ? child
        : encodeContent(child, prefix, path ? `${path}.${key}` : key, childSchema(schema, key), key);
    }
    return out;
  }
  return value;
}

/**
 * Overlay stored values on parsed ones where the types agree. Astro has
 * already parsed `base` (defaults applied, dates as Date objects); `stored` is
 * the raw saved form, so a stored string never replaces a Date, and keys the
 * schema defaulted survive.
 */
export function mergeStored(base: unknown, stored: unknown): unknown {
  if (stored === undefined) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(stored)) return base;
    return stored.map((item, index) => index < base.length ? mergeStored(base[index], item) : item);
  }
  if (isRecord(base)) {
    if (!isRecord(stored)) return base;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith("__")) continue;
      out[key] = key in base ? mergeStored(base[key], value) : value;
    }
    return out;
  }
  if (base === undefined || base === null) return stored;
  return typeof base === typeof stored ? stored : base;
}
