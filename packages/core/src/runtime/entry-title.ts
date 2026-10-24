import { ENTRY_TITLE_KEYS, plainText } from "./entry-search.js";
import type { CollectionStudioConfig } from "../types.js";

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
