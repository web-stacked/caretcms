/**
 * Shared JS-identifier primitives used across the wrap/usage/resolve passes.
 *
 * Centralised so "what is an identifier" and "how do we match a reference to
 * one" have a single definition — the matcher in particular is safety-relevant
 * (a missed reference can let `editable()` encode into an attribute), so it must
 * not drift between callers.
 */

/** A valid JS identifier (ASCII letters/digits plus `_` and `$`). */
export const IDENT = /^[A-Za-z_$][\w$]*$/;

export function isIdentifier(s: string): boolean {
  return IDENT.test(s);
}

/** Escape a string for safe literal use inside a `RegExp`. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex matching a whole-identifier reference to `name` in JS source.
 *
 * Uses `$`/`_`-aware lookaround boundaries rather than `\b`: `\b` sits between a
 * word and a non-word char, so `\b$item\b` does NOT match `$item` (the `$` is a
 * non-word char with no word char before it). Lookaround treats `$` and `_` as
 * identifier characters, so `$item` and `item$` are bounded correctly while a
 * substring like `item` inside `items` is still rejected.
 */
export function identRefRe(name: string, flags = ""): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, flags);
}

/** True when `js` references any of the given identifiers as a whole word. */
export function referencesIdent(js: string, names: readonly string[]): boolean {
  return names.some((n) => identRefRe(n).test(js));
}
