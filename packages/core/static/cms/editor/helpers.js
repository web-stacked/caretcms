export function parseCaretAttr(attr) {
  const parts = attr.split('::');
  if (parts.length === 3) return { collection: parts[0], id: parts[1], field: parts[2] };
  // Field-only (scoped) — return just the field, caller resolves scope
  if (parts.length === 1 && !attr.includes('::')) return { collection: null, id: null, field: attr };
  return null;
}

/**
 * Resolve a parsed binding by walking up the DOM to find data-caret-scope.
 * If the binding already has collection+id, returns as-is.
 * If field-only, walks up to nearest [data-caret-scope] ancestor.
 * Returns null if scope cannot be resolved.
 */
export function resolveBinding(el, parsed) {
  if (!parsed) return null;
  // Explicit null check, not truthiness: a malformed triple with an EMPTY
  // segment ("::x::y") must stay a (rejected) triple like the server treats
  // it, not silently fall back to scope resolution and save elsewhere.
  // Held to the rewrite engine by tests/unit/caret-parser-parity.test.ts.
  if (parsed.collection !== null && parsed.id !== null) return parsed;

  // Walk up to find nearest data-caret-scope
  let node = el.parentElement;
  while (node) {
    const scope = node.getAttribute('data-caret-scope');
    if (scope) {
      const parts = scope.split('::');
      if (parts.length === 2) {
        return { collection: parts[0], id: parts[1], field: parsed.field };
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Get the full data-caret key for an element, resolving scope if needed.
 * Returns "collection::id::field" or null if unresolvable.
 */
export function getResolvedKey(el) {
  const attr = el.getAttribute('data-caret');
  if (!attr) return null;
  const parsed = parseCaretAttr(attr);
  const resolved = resolveBinding(el, parsed);
  if (!resolved) return null;
  return `${resolved.collection}::${resolved.id}::${resolved.field}`;
}

export function flash(el, success) {
  const cls = success ? 'cms-saved' : 'cms-error';
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 2000);
}
