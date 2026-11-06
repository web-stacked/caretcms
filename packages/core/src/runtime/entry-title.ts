import { ENTRY_TITLE_KEYS, plainText } from "./entry-search.js";
import type { CollectionStudioConfig } from "../types.js";
import type { JsonSchemaNode } from "../schema-utils.js";

/** Required strings that address or decorate an entry rather than name it. */
const NOT_A_NAME = /^(id|slug|key|lang|locale|type|kind|layout|template|status|href|url|link|src|path|icon|image|img|photo|picture|avatar|cover|thumbnail|logo|video|file|color|colour|date|email|phone)$/i;

/** A plain text property: a string without an enum, const, or format. */
function isPlainString(node: JsonSchemaNode | undefined): boolean {
  return Boolean(node) && node!.type === "string" && !Array.isArray(node!.enum) && !("const" in node!) && typeof node!.format !== "string";
}

/**
 * The field that names a collection's entries, read from its schema: a usual
 * title field (title, headline, heading, name, …), else the first required
 * plain text field. Only top-level fields. Undefined without a schema.
 */
export function inferTitleField(schema: JsonSchemaNode | null | undefined): string | undefined {
  const properties = schema?.properties;
  if (!properties) return undefined;
  const known = ENTRY_TITLE_KEYS.find((key) => isPlainString(properties[key]));
  if (known) return known;
  return (schema?.required ?? []).find((key) => !NOT_A_NAME.test(key) && isPlainString(properties[key]));
}

/** "01-mara" → "01 mara", "about_us" → "About us". */
export function humanizeEntryId(id: string): string {
  const text = id.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The value at a dotted path, e.g. "hero.title". */
function valueAt(data: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, data);
}

/**
 * What editors call an entry, everywhere the Studio names one: a singleton by
 * its collection's label, else its configured title field, else a usual title
 * field, else its id made readable. Never markup.
 */
export function entryDisplayTitle(
  collection: string,
  id: string,
  data: Record<string, unknown> | null | undefined,
  config: Pick<CollectionStudioConfig, "label" | "titleField" | "singletonId">,
): string {
  if (config.singletonId && config.singletonId === id) {
    return config.label || humanizeEntryId(collection);
  }
  const record = data ?? {};
  const candidates = [
    ...(config.titleField ? [valueAt(record, config.titleField)] : []),
    ...ENTRY_TITLE_KEYS.map((key) => record[key]),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const text = plainText(candidate);
    if (text) return text;
  }
  return humanizeEntryId(id);
}
