/**
 * Shared rich-text allowlist + class matcher.
 *
 * The single source of truth for what the rich-text sanitizers keep. Imported
 * by the two TypeScript sanitizers — the server render path (sanitize-html.ts,
 * regex-based, no DOM) and the cloud live-sync path (browser-runtime.ts, DOM).
 *
 * The editor-save sanitizer in static/cms/editor/sanitize.js is shipped as raw,
 * unbundled JS, so it can't import this module — it MUST mirror these values
 * and the classAllowed() logic by hand. That hand mirror is held in lockstep by
 * tests/unit/contracts-parity.test.ts ("browser sanitizer parity"), which fails
 * CI on any drift (W0). Keep all three sanitizers in lockstep.
 */

/** Inline formatting tags the rich-text sanitizer preserves. */
export const RICH_ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "a", "br", "sub", "sup",
]);

/** Attributes preserved per tag (class is gated separately, by allowedClasses). */
export const RICH_ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
};

export const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/)/i;

/**
 * Per-tag class allowlist. Keys are tag names, values are allowed class names.
 * A pattern ending in `*` is a prefix match (`text-*` allows `text-primary`);
 * a lone `*` allows any class on that tag. Anything not matched is dropped.
 * Mirrors the `allowedClasses` option of the `sanitize-html` package.
 */
export type AllowedClasses = Record<string, readonly string[]>;

/** Does `cls` match any pattern in `patterns`? (exact, `prefix-*`, or lone `*`) */
export function classAllowed(cls: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === "*") return true;
    if (p.endsWith("*")) {
      if (cls.startsWith(p.slice(0, -1))) return true;
    } else if (cls === p) {
      return true;
    }
  }
  return false;
}

/** Filter a raw class attribute value to the tag's allowed patterns. */
export function filterClasses(value: string, patterns: readonly string[]): string {
  return value
    .split(/\s+/)
    .filter((c) => c !== "" && classAllowed(c, patterns))
    .join(" ");
}
