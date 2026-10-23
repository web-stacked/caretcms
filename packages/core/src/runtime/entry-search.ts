import { decodeHtmlEntities } from "./decode-entities.js";

/** Fields that name an entry, in the order the Studio shows them as its title. */
export const ENTRY_TITLE_KEYS = ["name", "title", "question", "company_name", "headline", "label"] as const;

const SNIPPET_RADIUS = 40;

/** How an entry matched a search: by its name (title or id), or inside a field. */
export type EntryMatch =
  | { kind: "title" }
  | { kind: "field"; field: string; snippet: string };

/** Readable text of a stored value: tags dropped, entities decoded, whitespace collapsed. */
function plainText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every string in the entry with its dotted path, in field order. */
function* stringFields(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) yield* stringFields(value[index], path ? `${path}.${index}` : String(index));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("__")) continue;
      yield* stringFields(child, path ? `${path}.${key}` : key);
    }
  }
}

/** The words around the first match, with ellipses where text was cut. */
function snippetAround(text: string, at: number, length: number): string {
  let start = Math.max(0, at - SNIPPET_RADIUS);
  let end = Math.min(text.length, at + length + SNIPPET_RADIUS);
  // Cut at word boundaries, never inside the match.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > at + length) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Match a lowercase query against an entry: its id or title first, then the
 * readable text of every other field.
 */
export function matchEntry(id: string, data: Record<string, unknown>, query: string): EntryMatch | null {
  const title = ENTRY_TITLE_KEYS.map((key) => data[key]).find((value): value is string => typeof value === "string" && value.length > 0);
  if (id.toLowerCase().includes(query) || (title !== undefined && title.toLowerCase().includes(query))) return { kind: "title" };
  for (const [field, raw] of stringFields(data, "")) {
    const text = plainText(raw);
    const at = text.toLowerCase().indexOf(query);
    if (at >= 0) return { kind: "field", field, snippet: snippetAround(text, at, query.length) };
  }
  return null;
}
