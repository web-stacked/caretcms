/**
 * Naming: derive a stable `collection::id` scope from a file path and assign a
 * unique, valid field name to each candidate.
 *
 * The field names a candidate gets are *permanent storage keys* once a user
 * edits — so naming must be deterministic (same input → same name every run),
 * seeded from any `data-caret` names already in the file (so re-runs never
 * reuse a name), unique within a scope (duplicate keys would mirror content at
 * runtime), and valid against the runtime's parser regexes.
 */

import type { Candidate } from "./detect.js";

// Mirror the runtime's mutation-contract regexes exactly. A label the runtime
// would reject must never be emitted.
const COLLECTION_RE = /^[a-z][a-z0-9_-]*$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const FIELD_RE = /^[a-z][a-z0-9_]*$/; // generated fields: keep them clean identifiers

export function isValidCollection(s: string): boolean {
  return COLLECTION_RE.test(s);
}
export function isValidId(s: string): boolean {
  return ID_RE.test(s);
}
export function isValidField(s: string): boolean {
  return FIELD_RE.test(s);
}

export interface Scope {
  collection: string;
  id: string;
}

export type ScopeReason = "dynamic-route" | "unsupported-location";

export type ScopeResult =
  | { scope: Scope }
  | { skip: ScopeReason };

/** Convert a PascalCase/camelCase or arbitrary filename to a valid id. */
function toId(name: string): string {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || "page";
}

/**
 * Derive the scope for a `.astro` file from its path relative to the project
 * root (POSIX-style or OS-style accepted). Returns a skip reason for dynamic
 * routes and locations we don't tag in v1.
 */
export function deriveScope(relPath: string): ScopeResult {
  const parts = relPath.replace(/\\/g, "/").replace(/^\.?\/+/, "").split("/");
  const srcIdx = parts.indexOf("src");
  const rel = srcIdx >= 0 ? parts.slice(srcIdx + 1) : parts;

  const [area, ...rest] = rel;
  if (rest.length === 0) return { skip: "unsupported-location" };

  // strip .astro from the final segment
  rest[rest.length - 1] = rest[rest.length - 1].replace(/\.astro$/i, "");

  // dynamic route segments like [slug] or [...rest] → no static identity
  if (rest.some((seg) => /^\[.*\]$/.test(seg))) return { skip: "dynamic-route" };

  if (area === "pages") {
    const segs = rest.filter((s) => s !== "index");
    const id = segs.length === 0 ? "home" : segs.map(toId).join("_");
    return { scope: { collection: "pages", id } };
  }
  if (area === "layouts") {
    return { scope: { collection: "site", id: toId(rest[rest.length - 1]) } };
  }
  if (area === "components") {
    return { scope: { collection: "components", id: toId(rest[rest.length - 1]) } };
  }
  return { skip: "unsupported-location" };
}

// Maximum words taken from text content when deriving a field name from it.
const SLUG_MAX_WORDS = 4;

/**
 * Derive a field name from an element's visible text — far more useful to an
 * editor than `subhead_3` (e.g. "Our Programs 🎨" → `our_programs`). Decodes
 * the few common HTML entities, strips emoji/accents/punctuation, and keeps the
 * first few words. Returns null when nothing usable remains (all emoji, leading
 * digits, etc.), so the caller falls back to a role-based name.
 */
export function slugifyText(text: string): string | null {
  const decoded = text
    .replace(/&amp;/g, " and ")
    .replace(/&(lt|gt|quot|nbsp|#0?39|apos);/g, " ")
    .replace(/['’]/g, ""); // keep contractions joined: What's → whats
  const ascii = decoded.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const cleaned = ascii.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!cleaned) return null;
  const slug = cleaned.split(/\s+/).slice(0, SLUG_MAX_WORDS).join("_");
  // Field names must start with a letter; if the text led with digits/symbols,
  // a role-based fallback reads better than a mangled slug.
  if (!/^[a-z]/.test(slug) || !isValidField(slug)) return null;
  return slug;
}

// Role-based field name, used when text isn't sluggable. `seenOfTag` lets the
// first <p> be "intro", first <img> "hero", etc.
function roleField(candidate: Candidate, seenOfTag: number): string {
  if (candidate.kind === "image") return seenOfTag === 0 ? "hero" : "image";
  switch (candidate.tag) {
    case "h1": return "headline";
    case "h2": return "subhead";
    case "h3":
    case "h4":
    case "h5":
    case "h6": return "heading";
    case "p": return seenOfTag === 0 ? "intro" : "body";
    case "blockquote": return "quote";
    case "li": return "item";
    case "a": return "link";
    case "button": return "button_label";
    case "figcaption":
    case "caption": return "caption";
    case "summary": return "summary";
    case "dt": return "term";
    case "dd": return "definition";
    case "th":
    case "td": return "cell";
    case "label": return "label";
    default: return "text";
  }
}

// Prose elements hold sentences, where a 4-word slug is an awkward fragment
// ("here_s_what_a"); a role name (intro/body) reads better. Label-like
// elements (headings, links, buttons, list items…) hold short phrases that
// slug cleanly ("our_programs"), which is far more useful than "subhead_3".
const PROSE_TAGS = new Set(["p", "blockquote", "dd"]);

// Preferred base field name: a content slug for short label-like elements (the
// editor-friendly default), a role name for prose. Determinism is preserved —
// the same element always yields the same base.
function baseField(candidate: Candidate, seenOfTag: number): string {
  if (candidate.kind === "text" && !PROSE_TAGS.has(candidate.tag)) {
    const slug = slugifyText(candidate.text);
    if (slug) return slug;
  }
  return roleField(candidate, seenOfTag);
}

function uniquify(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/**
 * Assign a unique field name to each candidate, in document order.
 *
 * `existingFields` seeds the used-name set with whatever `data-caret` field
 * names already live in the file's scope, so a partial first run, a manual
 * edit, or a re-run never collides with an existing binding.
 */
export function assignFields(
  candidates: Candidate[],
  existingFields: Iterable<string> = [],
): Map<Candidate, string> {
  const used = new Set<string>(existingFields);
  const seen = new Map<string, number>();
  const result = new Map<Candidate, string>();

  for (const c of candidates) {
    const key = c.kind === "image" ? "img" : c.tag;
    const seenCount = seen.get(key) ?? 0;
    seen.set(key, seenCount + 1);

    const name = uniquify(baseField(c, seenCount), used);
    used.add(name);
    result.set(c, name);
  }
  return result;
}
